// CloudFront viewer-request function.
//
//   www.noisebench.com/x  →  301 to https://noisebench.com/x   (one canonical host)
//   /                     →  /index.html
//   /markets              →  /markets.html                     (pretty URLs)
//
// Behind an origin access control S3 has no notion of a directory index, so
// without these rewrites every path that is not an exact object key would come
// back 403. Relative fetches on the pages ("data/metrics.json") still resolve
// correctly under the pretty URLs because the site lives at the domain root.
//
// The CloudFront Functions runtime is not full modern JS — no `includes`,
// `startsWith`, or template literals — hence the index arithmetic.

function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : "";

  if (host.indexOf("www.") === 0) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: {
          value:
            "https://" +
            host.substring(4) +
            request.uri +
            queryString(request.querystring),
        },
      },
    };
  }

  var uri = request.uri;

  if (uri.charAt(uri.length - 1) === "/") {
    request.uri = uri + "index.html";
    return request;
  }

  // Only the last segment matters: "/assets/viz.js" has an extension,
  // "/markets" does not.
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (lastSegment.indexOf(".") === -1) {
    request.uri = uri + ".html";
  }

  return request;
}

function queryString(querystring) {
  var parts = [];

  for (var key in querystring) {
    var param = querystring[key];

    if (param.multiValue) {
      for (var i = 0; i < param.multiValue.length; i++) {
        parts.push(
          encodeURIComponent(key) +
            "=" +
            encodeURIComponent(param.multiValue[i].value),
        );
      }
    } else {
      parts.push(
        encodeURIComponent(key) + "=" + encodeURIComponent(param.value),
      );
    }
  }

  return parts.length ? "?" + parts.join("&") : "";
}
