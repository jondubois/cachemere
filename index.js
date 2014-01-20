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
	response.end(this.content);
};

var Cachemere = function () {
	this.ERROR_TYPE_READ = 'read';
	this.ERROR_TYPE_COMPRESS = 'compress';
	this.ERROR_TYPE_PREP = 'prep';
	
	this.ENCODING_PLAIN = Cache.ENCODING_PLAIN;
	this.ENCODING_GZIP = 'gzip';
	
	this.CACHE_TYPE_NONE = Cache.CACHE_TYPE_NONE;
	this.CACHE_TYPE_WEAK = Cache.CACHE_TYPE_WEAK;
	this.CACHE_TYPE_STRONG = Cache.CACHE_TYPE_STRONG;
	this.CACHE_TYPE_PERMANENT = Cache.CACHE_TYPE_PERMANENT;
	
	this.init();
};

Cachemere.prototype = Object.create(EventEmitter.prototype);

Cachemere.prototype.init = function (options) {
	var self = this;
	
	var mainDir = path.dirname(require.main.filename) + '/';
	
	this._options = {
		compress: true,
		useETags: true,
		ignoreQueryString: true,
		delayFileUpdate: 1000,
		mapper: function (url) {
			return mainDir + url;
		},
		classifier: null
	};
	
	for (var i in options) {
		this._options[i] = options[i];
	}
	
	this._cache = new Cache(this._options);
	
	this.ready = true;
	
	this._gzipRegex = /\bgzip\b/;
	this._urlBodyRegex = /^[^\#\?]+/;
	
	this._useETags = this._options.useETags;
	this._mapper = this._options.mapper;
	
	this._defaultClassifier = function (url, cachemere) {
		return self.CACHE_TYPE_STRONG;
	};
	
	if (this._options.classifier) {
		this._classifier = this._options.classifier;
	} else {
		this._classifier = this._defaultClassifier;
	}
	this._encoding = this._options.compress ? this.ENCODING_GZIP : this.ENCODING_PLAIN;
	
	this._prepProvider = null;
	this._pendingProcessing = {};
	
	this._pendingFileChanges = {};
	this._pendingRequests = {};
	this._pendingUpdates = {};
	
	this._headerGen = function (options) {
		var headers = {
			'Content-Type': options.mime
		};
		
		if (self._useETags) {
			var eTag = self._cache.getHeader(self.ENCODING_PLAIN, options.url, 'ETag');
			if (eTag != null) {
				headers['ETag'] = eTag;
			}
		}
		if (self._options.compress && options.encoding != self.ENCODING_PLAIN) {
			headers['Content-Encoding'] = options.encoding;
		}
		
		return headers;
	};
	
	this._updateETag = function (url) {
		var headers = self._cache.getHeaders(self.ENCODING_PLAIN, url);
		var content = self._cache.get(self.ENCODING_PLAIN, url);
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
	this._depWatchers = {};
	this._deps = {};
	
	this._cache.on('set', function (url, encoding, cacheType) {
		if (self._watchers[url] == null && cacheType != self.CACHE_TYPE_PERMANENT) {
			var filePath = self._mapper(url);
			fs.exists(filePath, function (exists) {
				if (exists) {
					self._watchers[url] = fs.watch(filePath, self._handleFileChange.bind(self, url, filePath));
				}
			});
		}
		if (self._useETags && encoding == self.ENCODING_PLAIN) {
			self._updateETag(url);
		}
	});
	
	this._cache.on('clear', function (url, encoding) {
		if (encoding == self.ENCODING_PLAIN && self._watchers[url] != null) {
			self._watchers[url].close();
			delete self._watchers[url];
		}
	});
};

Cachemere.prototype.setClassifier = function (classifier) {
	this._classifier = classifier;
};

Cachemere.prototype._triggerNotice = function (err) {
	this.emit('notice', err);
};

Cachemere.prototype._triggerError = function (err) {
	this.emit('error', err);
};

Cachemere.prototype._handleFileChange = function (url, filePath) {
	var self = this;
	
	var options = {
		url: url,
		path: filePath
	};
	
	if (this._pendingFileChanges[url] != null) {
		clearTimeout(this._pendingFileChanges[url]);
		delete self._pendingFileChanges[url];
	}
	
	this._pendingFileChanges[url] = setTimeout(function () {
		fs.exists(filePath, function (exists) {
			if (exists) {
				self.set(options);
			} else {
				self._cache.clear(null, url);
			}
			delete self._pendingFileChanges[url];
		});
	}, this._options.delayFileUpdate);
};

Cachemere.prototype._valueToBuffer = function (value) {
	if (value == null) {
		return null;
	}
	if (!(value instanceof Buffer)) {
		if (typeof value != 'string') {
			value = value.toString();
		}
		value = new Buffer(value);
	}
	return value;
};

Cachemere.prototype._read = function (options, cb) {
	var self = this;
	
	var url = options.url;
	
	if (options.path === undefined) {
		options.path = this._mapper(url);
	};
	
	fs.readFile(options.path, function (err, content) {
		if (err) {
			self._cache.clear(null, url);
			err = new Error('The file at URL ' + url + ' does not exist or is not accessible');
			err.type = self.ERROR_TYPE_READ;
			cb(err);
			self._triggerNotice(err);
		} else {
			cb(null, content);
		}
	});
};

Cachemere.prototype._preprocess = function (options, content, cb) {
	var self = this;
	content = self._valueToBuffer(content);
	
	var url = options.url;
	var filePath = options.path;
	
	var preprocessor;
	if (this._prepProvider) {
		preprocessor = this._prepProvider(url);
	}

	if (preprocessor) {
		var resourceData = {
			url: url,
			path: filePath,
			content: content
		};
		
		var result;
		if (preprocessor) {
			result = preprocessor(resourceData, function (err, prepContent) {
				if (err) {
					if (!(err instanceof Error)) {
						err = new Error(err);
					}
					err.type = self.ERROR_TYPE_PREP;
					cb(err);
					self._triggerError(err);
				} else {
					prepContent = self._valueToBuffer(prepContent);
					self._cache.set(self.ENCODING_PLAIN, url, prepContent, options.cacheType);
					
					cb(null, prepContent);
				}
			});
		} else {
			result = resourceData.content;
		}
		
		if (result != null) {
			result = self._valueToBuffer(result);
			self._cache.set(self.ENCODING_PLAIN, url, result, options.cacheType);
			cb(null, result);
		}
	} else {
		self._cache.set(self.ENCODING_PLAIN, url, content, options.cacheType);
		cb(null, content);
	}
};

Cachemere.prototype._compress = function (options, content, cb) {
	var self = this;
	
	var url = options.url;
	
	zlib.gzip(content, function (err, result) {
		if (err) {
			if (!(err instanceof Error)) {
				err = new Error(err);
			}
			err.type = self.ERROR_TYPE_COMPRESS;
			cb(err);
			self._triggerError(err);
		} else {
			self._cache.set(self._encoding, url, result, options.cacheType);
			cb(null, result);
		}
	});
};

Cachemere.prototype._addHeaders = function (options, content, cb) {
	var headers = this._headerGen(options);
	this._cache.setHeaders(options.encoding, options.url, headers);
	cb(null, content, headers);
};

Cachemere.prototype._simplifyURL = function (url) {
	if (this._options.ignoreQueryString) {
		var matches = url.match(this._urlBodyRegex);
		if (matches) {
			url = matches[0];
		} else {
			url = '';
		}
	}
	return url;
};

Cachemere.prototype._processUpdates = function (url) {
	var self = this;

	var updateData = this._pendingUpdates[url].shift();
	var options = updateData.options;
	var callback = updateData.callback;
	var content = options.content;
	
	this._setPendingProcessing(url);
	
	options.encoding = this._encoding;
	
	if (options.path == null) {
		options.path = this._mapper(url);
	}
	if (options.mime == null) {
		options.mime = mime.lookup(options.path || url);
	}
	
	var tasks = [];
	
	if (content == null) {
		tasks.push(this._read.bind(this, options));
		tasks.push(this._preprocess.bind(this, options));
		if (this._options.compress) {
			tasks.push(this._compress.bind(this, options));
		}
		tasks.push(this._addHeaders.bind(this, options));
	} else {
		if (options.preprocessed) {
			this._cache.set(this.ENCODING_PLAIN, url, content, options.cacheType);
			if (this._options.compress) {
				tasks.push(this._compress.bind(this, options, content));
			}
			tasks.push(this._addHeaders.bind(this, options));
		} else {
			tasks.push(this._preprocess.bind(this, options, content));
			if (this._options.compress) {
				tasks.push(this._compress.bind(this, options));
			}
			tasks.push(this._addHeaders.bind(this, options));
		}
	}
	
	async.waterfall(tasks, function (err, content, headers) {
		callback && callback(err, content, headers);
		
		if (self._pendingUpdates[url] && self._pendingUpdates[url].length > 0) {
			self._processUpdates(url);
		} else {
			delete self._pendingUpdates[url];
			self._clearPendingProcessing(url);
		}
	});
};

Cachemere.prototype.set = function (options, callback) {
	var self = this;
	
	var updateOptions = {};
	for (var i in options) {
		updateOptions[i] = options[i];
	}
	
	updateOptions.url = this._simplifyURL(updateOptions.url);
	updateOptions.content = this._valueToBuffer(updateOptions.content);
	
	if (updateOptions.content != null && updateOptions.allowServeRaw) {
		this._cache.set(this.ENCODING_PLAIN, updateOptions.url, updateOptions.content, updateOptions.cacheType);
	}

	if (this._pendingUpdates[updateOptions.url] == null) {
		this._pendingUpdates[updateOptions.url] = [{
			options: updateOptions,
			callback: callback
		}];
		this._processUpdates(updateOptions.url);
	} else {
		this._pendingUpdates[updateOptions.url].push({
			options: updateOptions,
			callback: callback
		});
	}
};

Cachemere.prototype.setRaw = function (url, content, mime, allowServeRaw, callback) {
	var options = {
		url: url,
		content: content,
		mime: mime,
		allowServeRaw: allowServeRaw,
		cacheType: this.CACHE_TYPE_PERMANENT
	};
	this.set(options, callback);
};

Cachemere.prototype._fetch = function (options, callback) {
	var self = this;
	var url = options.url;
	
	if (this._pendingRequests[url] == null) {
		if (callback) {
			this._pendingRequests[url] = [{
				options: options,
				callback: callback
			}];
		}
		
		this._setPendingProcessing(url);
		
		if (options.path == null) {
			options.path = this._mapper(url);
		}
		if (options.mime == null) {
			options.mime = mime.lookup(options.path || url);
		}

		if (self._cache.has(self.ENCODING_PLAIN, url)) {
			var tasks = [
				function (cb) {
					var content = self._cache.get(self.ENCODING_PLAIN, url);
					cb(null, content);
				}
			];
		} else {
			var tasks = [
				this._read.bind(this, options),
				this._preprocess.bind(this, options)
			];
		}
		
		if (this._options.compress) {
			tasks.push(this._compress.bind(this, options));
		}
		
		tasks.push(this._addHeaders.bind(this, options));
		
		async.waterfall(tasks, function (err, content, headers) {
			var pendingRequests = self._pendingRequests[url];
			var encoding, cb;
			
			if (err) {
				for (var i in pendingRequests) {
					cb = pendingRequests[i].callback;
					cb && cb(err);
				}
			} else {
				for (var i in pendingRequests) {
					cb = pendingRequests[i].callback;
					encoding = pendingRequests[i].options.encoding;
					if (encoding == self.ENCODING_PLAIN) {
						content = self._cache.get(encoding, url);
						headers = self._cache.getHeaders(encoding, url);
						cb && cb(null, content, headers);
					} else {
						cb && cb(null, content, headers);
					}
				}
			}
			delete self._pendingRequests[url];
			self._clearPendingProcessing(url);
		});
	} else if (callback) {
		this._pendingRequests[url].push({
			options: options,
			callback: callback
		});
	}
};

Cachemere.prototype.fetch = function (req, callback) {
	var self = this;
	
	var url = this._simplifyURL(req.url);
	
	var reqHeaders = req.headers || {};
	var ifNoneMatch = reqHeaders['if-none-match'];
	var acceptEncodings = req.headers['accept-encoding'] || '';
	
	var encoding;
	if (this._gzipRegex.test(acceptEncodings)) {
		encoding = this._encoding;
	} else {
		encoding = this.ENCODING_PLAIN;
	}
	encoding = this._encoding;
	
	var res = new Resource();
	
	res.url = url;
	res.encoding = encoding;
	
	if (this._cache.has(encoding, url)) {
		this.emit('hit', url, encoding);
		res.hit = true;
		res.content = this._cache.get(encoding, url);
		res.modified = this.getModifiedTime(url, encoding);
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
		if (res.cacheType == null) {
			res.cacheType = this._classifier(url, self);
		}
		
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
				res.modified = self.getModifiedTime(url, encoding);
				
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

Cachemere.prototype.getModifiedTime = function (url, encoding) {
	url = this._simplifyURL(url);
	return this._cache.getModifiedTime(encoding || this._encoding, url);
};

Cachemere.prototype._setPendingProcessing = function (url) {
	this.ready = false;
	if (this._pendingProcessing[url] == null) {
		this._pendingProcessing[url] = 0;
	}
	this._pendingProcessing[url]++;
};

Cachemere.prototype._clearPendingProcessing = function (url) {
	if (this._pendingProcessing[url] != null) {
		this._pendingProcessing[url]--;
	}
	if (this._pendingProcessing[url] < 1) {
		delete this._pendingProcessing[url];
	}
	
	var isEmpty = true;
	for (var i in this._pendingProcessing) {
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

Cachemere.prototype.clear = function (url, encoding) {
	url = this._simplifyURL(url);
	return this._cache.clear(encoding, url);
};

Cachemere.prototype.has = function (url, encoding) {
	url = this._simplifyURL(url);
	return this._cache.has(encoding || this._encoding, url);
};

Cachemere.prototype.reset = function () {
	return this._cache.reset();
};

Cachemere.prototype.setDeps = function (url, deps) {
	if (this._depWatchers[url] != null) {
		for (var i in this._depWatchers[url]) {
			this._depWatchers[url][i].close();
		}
		delete this._depWatchers[url];
	}
	
	if (deps) {
		var filePath = this._mapper(url);
		this._depWatchers[url] = [];
		for (var j in deps) {
			this._depWatchers[url].push(fs.watch(deps[j], this._handleFileChange.bind(this, url, filePath)));
		}
		this._deps[url] = deps;
	} else if (this._deps[url]) {
		delete this._deps[url];
	}
};

Cachemere.prototype.clearDeps = function (url) {
	this.setDeps(url, null);
};

Cachemere.prototype.getDeps = function (url) {
	return this._deps[url];
};

Cachemere.prototype.setPrepProvider = function (prepProvider) {
	this._prepProvider = prepProvider;
};

Cachemere.prototype.getPrepProvider = function () {
	return this._prepProvider;
};

module.exports = new Cachemere();
module.exports.Resource = Resource;