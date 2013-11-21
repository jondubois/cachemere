Cachemere
======

A nice, smooth, cushiony layer of cache.

Cachemere is a self-updating server-side caching engine which greatly reduces the number of disk i/o operations and eases the CPU load on your server.
Cachemere caches preprocessed and/or compressed file contents and updates them when they change on the file system.
It also generates all necessary client-side caching headers so its caching capabilities extend to the client - These headers can be modified as required before being sent.

To install, run:

```bash
npm install cachemere
```

==================

#### Basic Example (fetches a file from disk or cache):

```js
var cachemere = require('cachemere');
var http = require('http');

var server = http.createServer(function (req, res) {
    cachemere.fetch(req, function (err, resource) {
		/*
		Note that you can manipulate the Resource object's 
		properties before outputting it to the response.
		*/
        resource.output(res);
    });
});
```

==================

## API

#### Top-level

These are exposed by `require('cachemere')`:

##### Events

- `hit`
	- Called when a resource is fetched from cache
	- **Arguments**
		- `url`: A resource URL
- `miss`
	- Called when a resource misses the cache and is fetched from disk
	- **Arguments**
		- `url`: A resource URL
- `error`
	- Called when Cachemere encounters an unexpected error
	- **Arguments**
		- `err`: An instance of Error with an additional property 'type' which can be 'read' (cachemere.ERROR_TYPE_READ), 'compress' (cachemere.ERROR_TYPE_COMPRESS) or 'prep' (cachemere.ERROR_TYPE_PREP).

##### Methods

- `init`
	- Resets and initializes Cachemere with an options object.
	- **Parameters**
		- `Object`: (Optional) An options object which Cachemere will use to configure itself.
		The options object can have the following properties:
			- `compress`: (Optional) A boolean which indicates whether or not to use GZIP compression. Defaults to true.
			- `useETags`: (Optional) A boolean which indicates whether or not to use ETags. ETag values are based on file content hash. Defaults to true.
			- `pathConverter`: (Optional) A function which converts any given URL into a path on the file system. The default converter interprets URLs as paths relative to the application's main file.
			- `cacheFilter`: (Optional) A function which decides whether a resource is cachable. Accepts a URL as argument. Return true to allow the URL to be cached and false to not cache it.
			- `maxSize`: (Optional) An integer which indicates the total maximum size of the server cache in bytes. Cachemere will automatically clear least-accessed resources from cache in order to meet the maxSize requirement. Defaults to 1000000000 (1GB).
			- `maxEntrySize`: (Optional) An integer which indicates the maximum size of a single cache entry in bytes. If a file exceeds this size, it will not be cached. Defaults to 10000000 (10MB).
			
- `fetch`
	- Fetches a file from cache or from the file system if not already cached. The act of fetching the file for the first time will cause Cachemere to cache it and watch that file for any changes.
	- **Parameters**
		- `http.IncomingMessage`: An HTTP request object (like the 'req' object passed to a HTTP request handler).
		- `Function`: A callback in the form function(err, resource) - The second argument is a cachemere.Resource object. The resource object can be manipulated and it can be output to a HTTP response. See the documentation about the Resource class below.
		If an err is present, it will be of type Error but with an added 'type' property which gives you details about the stage of caching in which the error occurred (read, preprocess or compress).

- `setPrepProvider`
	- Allows you to specify an optional preprocessor provider. If no prep provider is set, then Cachemere will not preprocess any of your files' contents before caching them.
	- **Parameters**
		- `Function`: A function which takes a URL as argument and returns a preprocessor function which will be used by Cachemere to preprocess that file's content. To skip preprocessing for a particular URL, this function should return null.
		A preprocessor function is in the form function(resourceData) - Where resourceData is an object with a url, path and content property. The content represent's the files content as a Buffer. The preprocessor function can return either a string or a Buffer.
		The returned value will be cached as the file's preprocessed content.

	**Example:**

	```js
	var textFileRegex = /\.txt$/;

	var textPrep = function (resource) {
		var data = resource.content.toString('utf8').replace(/[.]/g, '!');
		return data;
	};

	cachemere.setPrepProvider(function (url) {
		// Only preprocess files with .txt extension
		if (textFileRegex.test(url)) {
			return textPrep;
		}
		return null;
	});
	```

- `getPrepProvider`
	- Returns the preprocessor provider which is currently active.

	
#### Resource

A resource object is a representation of a resource on disk or in cache.
This resource can be output directly to an HTTP response object.
Note that you can manipulate any of the properties of a Resource before outputting it to a response in order to customize the behaviour.

##### Properties

- `status` _(Number)_: The status of the HTTP response associated with this resource.
- `headers` _(Object)_: An object representing headers which will be sent along with this resource's content. Feel free to add additional headers as required.
- `content` _(ReadableStream|Buffer)_: The resource's content as a readable stream or Buffer (depending on whether it should be streamed directly from the file system *miss* or served from cache *hit*).

##### Methods

- `output`
	- Automatically writes the resource's content and any associated headers to the HTTP response object.
	- **Parameters**
		- `http.ServerResponse`: A response object to output the resource's data to (status, headers and content will be sent).