var EventEmitter = require('events').EventEmitter;
var ExpiryManager = require('expirymanager').ExpiryManager;

var Cache = function (options) {
	var self = this;
	
	self.ENCODING_PLAIN = Cache.ENCODING_PLAIN;
	self.ENCODING_SEPARATOR = Cache.ENCODING_SEPARATOR;
	
	self.CACHE_TYPE_NONE = Cache.CACHE_TYPE_NONE;
	self.CACHE_TYPE_WEAK = Cache.CACHE_TYPE_WEAK;
	self.CACHE_TYPE_STRONG = Cache.CACHE_TYPE_STRONG;
	self.CACHE_TYPE_PERMANENT = Cache.CACHE_TYPE_PERMANENT;
	
	self._expiryManager = new ExpiryManager();
	
	self.reset = function () {
		self._cache = {};
		self._encodings = {};
		self._totalSize = 0;
		
		self._head = {
			prev: null
		};
		self._tail = {
			next: null
		};
		self._head.next = self._tail;
		self._tail.prev = self._head;
	};
	
	self.reset();
	
	self._maxSize = options.maxSize || 1000000000;
	self._maxEntrySize = options.maxEntrySize || 10000000;
	self._cacheLife = options.cacheLife || 3600;
	self._expiryCheckInterval = (options.expiryCheckInterval || 10) * 1000;
	
	self._expireInterval = setInterval(function () {
		var keyParts;
		var expireKeys = self._expiryManager.extractExpiredKeys();
		
		for (var i in expireKeys) {
			keyParts = expireKeys[i].split(self.ENCODING_SEPARATOR);
			self.clear(keyParts[0], keyParts[1]);
		}
	}, self._expiryCheckInterval);
	
	self._getFullKey = function (encoding, key) {
		return encoding + self.ENCODING_SEPARATOR + key;
	};
	
	self._floatCacheEntry = function (entry) {
		if (entry.next) {
			entry.next.prev = entry.prev;
			entry.prev.next = entry.next;
		}
		entry.next = self._head.next;
		entry.prev = self._head;
		self._head.next.prev = entry;
		self._head.next = entry;
	};
	
	self._removeCacheEntry = function (entry) {
		entry.prev.next = entry.next;
		entry.next.prev = entry.prev;
	};
	
	self._addKeyEncoding = function (key, encoding) {
		if (self._encodings[key] == null) {
			self._encodings[key] = {};
		}
		self._encodings[key][encoding] = 1;
	};
	
	self._removeKeyEncoding = function (key, encoding) {
		if (self._encodings[key] != null) {
			delete self._encodings[key][encoding];
		}
		var empty = true;
		for (var i in self._encodings[key]) {
			empty = false;
			break;
		}
		if (empty) {
			delete self._encodings[key];
		}
	};
	
	self.set = function (encoding, key, data, cacheType) {
		if (cacheType == self.CACHE_TYPE_NONE) {
			return false;
		}
		
		var permanent;
		var weak;
		if (cacheType) {
			permanent = (cacheType == self.CACHE_TYPE_PERMANENT);
			weak = (cacheType == self.CACHE_TYPE_WEAK);
		} else {
			cacheType = self.CACHE_TYPE_STRONG;
		}
		
		if (data == null) {
			data = new Buffer('');
		} else {
			if (!(data instanceof Buffer)) {
				if (typeof data != 'string') {
					data = data.toString();
				}
				data = new Buffer(data);
			}
		}
		
		var size = data.length;
		if (size > self._maxEntrySize && !permanent) {
			return false;
		}
		
		var fullKey = self._getFullKey(encoding, key);
		
		if (self._cache.hasOwnProperty(fullKey)) {
			var headers = self._cache[fullKey].headers || {};
			self.clear(encoding, key);
			var now = Date.now();
		} else {
			headers = {};
		}
		
		if (permanent) {
			self._cache[fullKey] = {data: data, headers: headers, time: Date.now(), cacheType: cacheType};
		} else {
			var entry = {
				key: fullKey,
				size: size
			};
			self._floatCacheEntry(entry);
			self._cache[fullKey] = {data: data, headers: headers, time: Date.now(), entry: entry, cacheType: cacheType};
			if (weak) {
				self._expiryManager.expire([fullKey], self._cacheLife);
			}
		}
		
		self._addKeyEncoding(key, encoding);
		self.emit('set', key, encoding, cacheType);
		
		self._totalSize += size;
		
		var curEntry = self._tail.prev;
		var keyParts;
		while (self._totalSize > self._maxSize && curEntry && curEntry.key != null) {
			keyParts = curEntry.key.split(self.ENCODING_SEPARATOR);
			self.clear(keyParts[0], keyParts[1]);
			curEntry = self._tail.prev;
		}
		
		return true;
	};
	
	self.get = function (encoding, key) {
		var fullKey = self._getFullKey(encoding, key);
		if (self._cache.hasOwnProperty(fullKey)) {
			var entry = self._cache[fullKey].entry;
			if (entry) {
				self._floatCacheEntry(entry);
				if (self._cache[fullKey].cacheType == self.CACHE_TYPE_WEAK) {
					self._expiryManager.expire([fullKey], self._cacheLife);
				}
			}
			return self._cache[fullKey].data;
		}
		return null;
	};
	
	self.getModifiedTime = function (encoding, key) {
		var fullKey = self._getFullKey(encoding, key);
		if (self._cache.hasOwnProperty(fullKey)) {
			var entry = self._cache[fullKey].entry;
			if (entry) {
				self._floatCacheEntry(entry);
			}
			var time = self._cache[fullKey].time;
			if (time == null) {
				return -1;
			}
			return time;
		} else {
			return -1;
		}
	};
	
	self.has = function (encoding, key) {
		var fullKey = self._getFullKey(encoding, key);
		return self._cache.hasOwnProperty(fullKey) && self._cache[fullKey].hasOwnProperty('data');
	};
	
	self.clear = function (encoding, key) {
		if (encoding) {
			var fullKey = self._getFullKey(encoding, key);
			if (self._cache[fullKey] != null) {
				var curEntry = self._cache[fullKey].entry;
				if (curEntry) {
					self._totalSize -= curEntry.size;
					self._removeCacheEntry(curEntry);
					if (self._cache[fullKey].cacheType == self.CACHE_TYPE_WEAK) {
						self._expiryManager.unexpire([fullKey]);
					}
				}
				delete self._cache[fullKey];
				
				self._removeKeyEncoding(key, encoding);
				self.emit('clear', key, encoding);
			}
		} else {
			// Clear URL entry for every encoding used with the key
			var encodings = [];
			for (var i in self._encodings[key]) {
				encodings.push(i);
			}
			for (var j in encodings) {
				self.clear(encodings[j], key);
			}
		}
	};
	
	self.setHeader = function (encoding, objectKey, headerKey, headerValue) {
		var fullObjectKey = self._getFullKey(encoding, objectKey);
		
		if (!self._cache.hasOwnProperty(fullObjectKey)) {
			return false;
		}
		self._cache[fullObjectKey].headers[headerKey] = headerValue;
		
		return true;
	};
	
	self.getHeader = function (encoding, objectKey, headerKey) {
		var fullObjectKey = self._getFullKey(encoding, objectKey);
		
		if (self._cache.hasOwnProperty(fullObjectKey)) {
			if (self._cache[fullObjectKey].headers.hasOwnProperty(headerKey)) {
				return self._cache[fullObjectKey].headers[headerKey];
			} else {
				return null;
			}
		}
		
		fullObjectKey = self._getFullKey(self.ENCODING_PLAIN, objectKey);
		
		if (self._cache.hasOwnProperty(fullObjectKey)) {
			if (self._cache[fullObjectKey].headers.hasOwnProperty(headerKey)) {
				return self._cache[fullObjectKey].headers[headerKey];
			}
		}
		
		return null;
	};
	
	self.setHeaders = function (encoding, objectKey, headerMap) {
		var i;
		for (i in headerMap) {
			self.setHeader(encoding, objectKey, i, headerMap[i]);
		}
	};
	
	self.getHeaders = function (encoding, objectKey) {
		var fullObjectKey = self._getFullKey(encoding, objectKey);
		if (self._cache.hasOwnProperty(fullObjectKey) && self._cache[fullObjectKey].headers) {
			return self._cache[fullObjectKey].headers;
		}
		return {};
	};
	
	self.clearHeader = function (encoding, objectKey, headerKey) {
		var fullObjectKey = self._getFullKey(encoding, objectKey);
		
		if (self._cache.hasOwnProperty(fullObjectKey) && self._cache[fullObjectKey].headers) {
			if (self._cache[fullObjectKey].headers.hasOwnProperty(headerKey)) {
				delete self._cache[fullObjectKey].headers[headerKey];
			}
		}
	};
	
	self.clearHeaders = function (encoding, objectKey) {
		var fullObjectKey = self._getFullKey(encoding, objectKey);
		
		if (self._cache.hasOwnProperty(fullObjectKey) && self._cache[fullObjectKey].headers) {
			self._cache[fullObjectKey].headers = {};
		}
	};
	
	self.clearMatches = function (regex) {
		var i, keyParts;
		for (i in self._cache) {
			if (regex.test(i)) {
				keyParts = i.split(self.ENCODING_SEPARATOR);
				self.clear(keyParts[1], keyParts[0]);
			}
		}
	};
};

Cache.prototype = Object.create(EventEmitter.prototype);

Cache.ENCODING_PLAIN = 'plain';
Cache.ENCODING_SEPARATOR = '::';

Cache.CACHE_TYPE_NONE = 0;
Cache.CACHE_TYPE_WEAK = 1;
Cache.CACHE_TYPE_STRONG = 2;
Cache.CACHE_TYPE_PERMANENT = 3;

module.exports.Cache = Cache