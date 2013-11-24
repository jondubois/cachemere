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
	
	this._cache.on('set', function (url, encoding, permanent) {
		if (self._watchers[url] == null && !permanent) {
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

Cachemere.prototype._read = function (options, cb) {
	var self = this;
	
	var url = options.url;
	var filePath = options.path;
	
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

Cachemere.prototype._preprocess = function (options, content, cb) {
	var self = this;
	
	var url = options.url;
	var filePath = options.path;
	
	var preprocessor;
	if (this._prepProvider) {
		preprocessor = this._prepProvider(url);
	}

	if (preprocessor) {
		var buffers = [];
		
		var prepContent = function () {
			var resBuffer = Buffer.concat(buffers);
			
			var resourceData = {
				url: url,
				path: filePath,
				content: resBuffer
			};
			
			if (content.error) {
				cb(content.error);
			} else {
				var result = preprocessor(resourceData, function (err, content) {
					if (!(content instanceof Buffer)) {
						if (typeof content != 'string') {
							content = content.toString();
						}
						content = new Buffer(content);
					}
					if (!(err instanceof Error)) {
						err = new Error(err);
					}
					err.type = self.ERROR_TYPE_PREP;
					
					if (!self._options.compress) {
						self._cache.set(self._cache.ENCODING_PLAIN, url, content, options.permanent);
					}
					cb(err, content);
				});
				
				if (result != null) {
					if (!(result instanceof Buffer)) {
						if (typeof result != 'string') {
							result = result.toString();
						}
						result = new Buffer(result);
					}
					if (!self._options.compress) {
						self._cache.set(self._cache.ENCODING_PLAIN, url, result, options.permanent);
					}
					cb(null, result);
				}
			}
		};
		
		if (content instanceof Buffer) {
			buffers.push(content);
			prepContent();
		} else {
			content.on('data', function (data) {
				buffers.push(data);
			});
			content.on('end', prepContent);
		}
	} else {
		if (!self._options.compress) {
			var buffers = [];
			
			content.on('data', function (data) {
				buffers.push(data);
			});
			content.on('end', function () {
				if (!content.error) {
					var resBuffer = Buffer.concat(buffers);
					self._cache.set(self._cache.ENCODING_PLAIN, url, resBuffer, options.permanent);
				}
			});
		}
		cb(null, content);
	}
};

Cachemere.prototype._compress = function (options, content, cb) {
	var self = this;
	
	var url = options.url;
	
	if (content instanceof Buffer) {
		zlib.gzip(content, function (err, result) {
			if (err) {
				if (!(err instanceof Error)) {
					err = new Error(err);
				}
				err.type = self.ERROR_TYPE_COMPRESS;
				cb(err);
			} else {
				self._cache.set(self._encoding, url, result, options.permanent);
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
				self._cache.set(self._encoding, url, resBuffer, options.permanent);
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

Cachemere.prototype._addHeaders = function (options, content, cb) {
	var url = options.url;
	var res = {
		url: url,
		mime: mime.lookup(url)
	};
	var headers = this._headerGen(res);
	
	this._cache.setHeaders(this._encoding, url, headers);
	cb(null, content, headers);
};

Cachemere.prototype._fetch = function (url, filePath, callback) {
	var options = {
		url: url,
		path: filePath
	};
	
	var tasks = [
		this._read.bind(this, options),
		this._preprocess.bind(this, options)
	];
	
	if (this._options.compress) {
		tasks.push(this._compress.bind(this, options));
	}
	
	tasks.push(this._addHeaders.bind(this, options));
	
	async.waterfall(tasks, function (err, content, headers) {
		callback && callback(err, content, headers);
	});
};

Cachemere.prototype.fetch = function (req, callback) {
	var self = this;
	
	var req = arguments[0];
	var url = req.url;
	var reqHeaders = req.headers || {};
	var ifNoneMatch = reqHeaders['if-none-match'];
	
	var res = new Resource();
	
	res.url = url;
	res.encoding = this._encoding;
	
	if (this._cache.has(this._encoding, url)) {
		this.emit('hit', url);
		res.content = this._cache.get(this._encoding, url);
		res.modified = this.getModifiedTime(url);
		res.type = this.RESOURCE_TYPE_BUFFER;
		
		var hash = this._cache.getHeader(this._encoding, url, 'ETag');
		
		if (ifNoneMatch != null && ifNoneMatch == hash) {
			res.status = 304;
			res.content = null;
		} else {
			res.status = 200;
		}
		res.headers = this._cache.getHeaders(this._encoding, url);
		callback(null, res);
		
	} else {
		this.emit('miss', url);
		var filePath = this._pathConverter(url);
		this._fetch(url, filePath, function (err, content, headers) {
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
				res.modified = self.getModifiedTime(url);
				res.type = self.RESOURCE_TYPE_STREAM;
				
				if (ifNoneMatch != null && ifNoneMatch == headers['ETag']) {
					res.status = 304;
					res.content = null;
				} else {
					res.status = 200;
					res.content = content;
				}
				res.headers = headers;
			}
			callback(err, res);
		});
	}
};

Cachemere.prototype.getModifiedTime = function (url) {
	return this._cache.getModifiedTime(this._encoding, url);
};

Cachemere.prototype.set = function (url, content, callback) {	
	if (!(content instanceof Buffer)) {
		if (typeof content != 'string') {
			content = content.toString();
		}
		content = new Buffer(content);
	}

	var options = {
		url: url,
		permanent: true
	};
	
	var tasks = [
		this._preprocess.bind(this, options, content)
	];
	
	if (this._options.compress) {
		tasks.push(this._compress.bind(this, options));
	}
	
	tasks.push(this._addHeaders.bind(this, options));
	
	async.waterfall(tasks, function (err, content) {
		callback && callback(err, content);
	});
};

Cachemere.prototype.clear = function (url) {
	return this._cache.clear(null, url);
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