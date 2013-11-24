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
		mapper: function (url) {
			return mainDir + url;
		}
	};
	
	for (var i in options) {
		this._options[i] = options[i];
	}
	
	this._cache = new Cache(this._options);
	this.ready = true;
	
	this._gzipRegex = /\bgzip\b/;
	
	this._useETags = this._options.useETags;
	this._mapper = this._options.mapper;
	this._encoding = this._options.compress ? 'gzip' : this._cache.ENCODING_PLAIN;
	
	this._prepProvider = null;
	this._pendingCache = {};
	
	this._headerGen = function (options) {
		var headers = {
			'Content-Type': options.mime
		};
		
		if (self._useETags) {
			var eTag = self._cache.getHeader(options.encoding, options.url, 'ETag');
			if (eTag != null) {
				headers['ETag'] = eTag;
			}
		}
		
		if (self._options.compress && options.encoding != self._cache.ENCODING_PLAIN) {
			headers['Content-Encoding'] = options.encoding;
		}
		
		return headers;
	};
	
	this._updateETag = function (url, encoding) {
		var headers = self._cache.getHeaders(encoding, url);
		var content = self._cache.get(encoding, url);
		if (content == null) {
			headers['ETag'] = '-1';
		} else {
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
			var filePath = self._mapper(url);
			fs.exists(filePath, function (exists) {
				if (exists) {
					self._watchers[url] = fs.watch(filePath, self._handleFileChange.bind(self, url, filePath));
				}
			});
		}
		if (self._useETags) {
			self._updateETag(url, encoding);
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
	var options = {
		url: url,
		path: filePath,
		encoding: this._encoding,
		forceRefresh: true
	};
	this._fetch(options);
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
					
					self._cache.set(self._cache.ENCODING_PLAIN, url, content, options.permanent);
					cb(err, content);
				});
				
				if (result != null) {
					if (!(result instanceof Buffer)) {
						if (typeof result != 'string') {
							result = result.toString();
						}
						result = new Buffer(result);
					}
					self._cache.set(self._cache.ENCODING_PLAIN, url, result, options.permanent);
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
	var headers = this._headerGen(options);
	this._cache.setHeaders(options.encoding, options.url, headers);
	cb(null, content, headers);
};

Cachemere.prototype._fetch = function (options, callback) {
	var self = this;
	
	this._setPendingCache(options.url);
	
	if (options.mime == null) {
		options.mime = mime.lookup(options.path || options.url);
	}

	if (self._cache.has(self._cache.ENCODING_PLAIN, options.url) && !options.forceRefresh) {
		var tasks = [
			function (options, cb) {
				var content = self._cache.get(self._cache.ENCODING_PLAIN, options.url);
				cb(null, content);
			}
		];
	} else {
		var tasks = [
			this._read.bind(this, options),
			this._preprocess.bind(this, options)
		];
	}
	
	if (this._options.compress && options.encoding != this._cache.ENCODING_PLAIN) {
		tasks.push(this._compress.bind(this, options));
	}
	
	tasks.push(this._addHeaders.bind(this, options));
	
	async.waterfall(tasks, function (err, content, headers) {
		self._clearPendingCache(options.url);
		callback && callback(err, content, headers);
	});
};

Cachemere.prototype.fetch = function (req, callback) {
	var self = this;
	
	var req = arguments[0];
	var url = req.url;
	var reqHeaders = req.headers || {};
	var ifNoneMatch = reqHeaders['if-none-match'];
	var acceptEncodings = req.headers['accept-encoding'] || '';
	
	var encoding;
	if (this._gzipRegex.test(acceptEncodings)) {
		encoding = this._encoding;
	} else {
		encoding = this._cache.ENCODING_PLAIN;
	}
	
	var res = new Resource();
	
	res.url = url;
	res.encoding = encoding;
	
	if (this._cache.has(encoding, url)) {
		this.emit('hit', url, encoding);
		res.hit = true;
		res.content = this._cache.get(encoding, url);
		res.modified = this.getModifiedTime(url);
		res.type = this.RESOURCE_TYPE_BUFFER;
		
		res.headers = this._cache.getHeaders(encoding, url);
		
		if (ifNoneMatch != null && res.headers && ifNoneMatch == res.headers['ETag']) {
			res.status = 304;
			res.content = null;
		} else {
			res.status = 200;
		}
		callback(null, res);
		
	} else {
		this.emit('miss', url, encoding);
		res.hit = false;
		res.path = this._mapper(url);
		this._fetch(res, function (err, content, headers) {
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

Cachemere.prototype._setPendingCache = function (url) {
	this.ready = false;
	this._pendingCache[url] = true;
};

Cachemere.prototype._clearPendingCache = function (url) {
	delete this._pendingCache[url];
	var isEmpty = true;
	for (var i in this._pendingCache) {
		isEmpty = false;
		break;
	}
	if (isEmpty) {
		this.ready = true;
		this.emit('ready');
		this.removeAllListeners('ready');
	}
};

Cachemere.prototype.on = function (event, listener) {
	if (event == 'ready' && this.ready) {
		listener();
	} else {
		EventEmitter.prototype.on.apply(this, arguments);
	}
};

Cachemere.prototype.set = function (url, content, mime, callback) {
	var self = this;
	
	if (!(content instanceof Buffer)) {
		if (typeof content != 'string') {
			content = content.toString();
		}
		content = new Buffer(content);
	}

	this._setPendingCache(url);
	
	var options = {
		url: url,
		mime: mime,
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
		self._clearPendingCache(url);
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