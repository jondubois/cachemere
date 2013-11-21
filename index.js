var Cache = require('./cache').Cache;
var async = require('async');
var zlib = require('zlib');
var fs = require('fs');
var mime = require('mime');
var path = require('path');
var Readable = require('stream').Readable;
var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');

var Resource = function () {
	this.status = 200;
	this.headers = null;
	this.content = null;
};

Resource.prototype.output = function (response) {
	response.writeHead(this.status, this.headers);
	if (this.content && this.content.pipe) {
		this.content.on('error', function () {
			response.destroy();
		});
		this.content.pipe(response);
	} else {
		response.end(this.content);
	}
};

var Cachemere = function () {
	this.RESOURCE_TYPE_STREAM = 'stream';
	this.RESOURCE_TYPE_BUFFER = 'buffer';
	
	this.ERROR_TYPE_READ = 'read';
	this.ERROR_TYPE_COMPRESS = 'compress';
	this.ERROR_TYPE_PREP = 'prep';
	
	this.init();
};

Cachemere.prototype = Object.create(EventEmitter.prototype);

Cachemere.prototype.init = function (options) {
	var self = this;
	
	var mainDir = path.dirname(require.main.filename) + '/';
	
	this._options = {
		compress: true,
		useETags: true,
		pathConverter: function (url) {
			return mainDir + url;
		}
	};
	
	for (var i in options) {
		this._options[i] = options[i];
	}
	
	this._cache = new Cache(this._options);
	
	this._useETags = this._options.useETags;
	this._pathConverter = this._options.pathConverter;
	this._encoding = this._options.compress ? 'gzip' : this._cache.ENCODING_PLAIN;
	
	this._prepProvider = null;
	
	this._headerGen = function (cacheData) {
		var headers = {
			'Content-Type': cacheData.mime
		};
		
		if (self._useETags) {
			var eTag = self._cache.getHeader(self._encoding, cacheData.url, 'ETag');
			if (eTag != null) {
				headers['ETag'] = eTag;
			}
		}
		
		if (self._options.compress) {
			headers['Content-Encoding'] = self._encoding;
		}
		
		return headers;
	};
	
	this._updateETag = function (url) {
		var headers = self._cache.getHeaders(self._encoding, url);
		var content = self._cache.get(self._encoding, url);
		if (content != null) {
			var shasum = crypto.createHash('sha1');
			if (content instanceof Buffer) {
				shasum.update(content);
			} else {
				shasum.update(content, 'utf8');
			}
			headers['ETag'] = shasum.digest('hex');
		}
	};
	
	this._watchers = {};
	
	this._cache.on('set', function (url, encoding) {
		if (self._watchers[url] == null) {
			var filePath = self._pathConverter(url);
			fs.exists(filePath, function (exists) {
				if (exists) {
					self._watchers[url] = fs.watch(filePath, self._handleFileChange.bind(self, url, filePath));
				}
			});
		}
		if (self._useETags && encoding == self._encoding) {
			self._updateETag(url);
		}
	});
	
	this._cache.on('clear', function (url) {
		if (self._watchers[url] != null) {
			self._watchers[url].close();
			delete self._watchers[url];
		}
	});
};

Cachemere.prototype._triggerError = function (err) {
	this.emit('error', err);
};

Cachemere.prototype._handleFileChange = function (url, filePath) {
	this._fetch(url, filePath);
};

Cachemere.prototype._read = function (url, filePath, cb) {
	var self = this;
	
	fs.exists(filePath, function (exists) {
		var stream = null;
		if (exists) {
			stream = fs.createReadStream(filePath);
			cb(null, stream);
		} else {
			self._cache.clear(null, url);
			var err = new Error('The file at URL ' + url + ' does not exist');
			err.type = self.ERROR_TYPE_READ;
			cb(err);
		}
	});
};

Cachemere.prototype._preprocess = function (url, filePath, stream, cb) {
	var self = this;
	
	var preprocessor;
	if (this._prepProvider) {
		preprocessor = this._prepProvider(url);
	}

	var buffers = [];
	if (preprocessor) {
		stream.on('data', function (data) {
			buffers.push(data);
		});
		stream.on('end', function () {
			var resBuffer = Buffer.concat(buffers);
			
			var resourceData = {
				url: url,
				path: filePath,
				content: resBuffer
			};
			
			if (stream.error) {
				cb(stream.error);
			} else {
				var result = preprocessor(resourceData, function (err, content) {
					if (!(content instanceof Buffer)) {
						content = new Buffer(content);
					}
					if (!(err instanceof Error)) {
						err = new Error(err);
					}
					err.type = self.ERROR_TYPE_PREP;
					
					self._cache.set(self._cache.ENCODING_PLAIN, url, content);
					cb(err, content);
				});
				
				if (result != null) {
					if (!(result instanceof Buffer)) {
						result = new Buffer(result);
					}
					self._cache.set(self._cache.ENCODING_PLAIN, url, result);
					cb(null, result);
				}
			}
		});
	} else {
		stream.on('data', function (data) {
			buffers.push(data);
		});
		stream.on('end', function () {
			if (!stream.error) {
				var resBuffer = Buffer.concat(buffers);
				self._cache.set(self._cache.ENCODING_PLAIN, url, resBuffer);
			}
		});
		cb(null, stream);
	}
};

Cachemere.prototype._compress = function (url, content, cb) {
	var self = this;
	
	if (content instanceof Buffer) {
		zlib.gzip(content, function (err, result) {
			if (err) {
				if (!(err instanceof Error)) {
					err = new Error(err);
				}
				err.type = self.ERROR_TYPE_COMPRESS;
				cb(err);
			} else {
				self._cache.set(self._encoding, url, result);
				cb(null, result);
			}
		});
	} else {
		var buffers = [];
		var compressorStream = zlib.createGzip();
		
		compressorStream.on('data', function (data) {
			buffers.push(data);
		});
		
		compressorStream.on('error', function (err) {
			compressorStream.error = err;
			self._triggerError(err);
		});
		
		compressorStream.on('end', function () {
			if (!content.error && !compressorStream.error) {
				var resBuffer = Buffer.concat(buffers);
				self._cache.set(self._encoding, url, resBuffer);
			}
		});
		
		content.on('error', function (err) {
			content.error = err;
			compressorStream.end();
			compressorStream.emit('error', err);
		});
		
		content.pipe(compressorStream);
		cb(null, compressorStream);
	}
};

Cachemere.prototype._fetch = function (url, filePath, callback) {
	var self = this;
	
	var tasks = [
		this._read.bind(this, url, filePath),
		this._preprocess.bind(this, url, filePath)
	];
	
	if (this._options.compress) {
		tasks.push(this._compress.bind(this, url));
	}
	
	async.waterfall(tasks, function (err, content) {
		callback && callback(err, content);
	});
};

Cachemere.prototype.fetch = function (req, callback) {
	var self = this;
	
	var req = arguments[0];
	var url = req.url;
	var reqHeaders = req.headers || {};
	
	var res = new Resource();
	
	res.url = url;
	res.encoding = this._encoding;
	res.mime = mime.lookup(url);
	
	if (this._cache.has(this._encoding, url)) {
		this.emit('hit', url);
		res.content = this._cache.get(this._encoding, url);
		res.modified = this.getModifiedTime(url);
		var hash = this._cache.getHeader(this._encoding, url, 'ETag');
		var ifNoneMatch = reqHeaders['if-none-match'];
		if (ifNoneMatch != null && ifNoneMatch == hash) {
			res.status = 304;
			res.content = null;
		} else {
			res.status = 200;
		}
		res.type = this.RESOURCE_TYPE_BUFFER;
		res.headers = this._cache.getHeaders(this._encoding, url);
		callback(null, res);
	} else {
		this.emit('miss', url);
		var filePath = this._pathConverter(url);
		this._fetch(url, filePath, function (err, content) {
			if (err) {
				if (err.type == self.ERROR_TYPE_READ) {
					res.status = 404;
				} else {
					res.status = 500;
				}
				if (err instanceof Error) {
					res.content = err.message + '.';
				} else {
					res.content = err + '.';
				}
				res.headers = {
					'Content-Type': 'text/html'
				};
			} else {
				res.status = 200;
				res.content = content;
				res.modified = self.getModifiedTime(url);
				res.type = self.RESOURCE_TYPE_STREAM;
				res.headers = self._headerGen(res);
				self._cache.setHeaders(self._encoding, url, res.headers);
			}
			callback(err, res);
		});
	}
};

Cachemere.prototype.getModifiedTime = function (url) {
	return this._cache.getModifiedTime(this._encoding, url);
};

Cachemere.prototype.set = function (url, content, permanent) {
	return this._cache.set(this._encoding, url, content, permanent);
};

Cachemere.prototype.clear = function (url) {
	return this._cache.clear(this._encoding, url);
};

Cachemere.prototype.has = function (url) {
	return this._cache.has(this._encoding, url);
};

Cachemere.prototype.reset = function () {
	return this._cache.reset();
};

Cachemere.prototype.setPrepProvider = function (prepProvider) {
	this._prepProvider = prepProvider;
};

Cachemere.prototype.getPrepProvider = function () {
	return this._prepProvider;
};

module.exports = new Cachemere();
module.exports.Resource = Resource;