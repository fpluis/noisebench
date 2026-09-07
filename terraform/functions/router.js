// CloudFront viewer-request function.
//
//   www.noisebench.com/x  →  301 to https://noisebench.com/x   (one canonical host)
//   /markets.html         →  301 to /markets                   (one canonical path)
//   /index.html           →  301 to /
//   /                     →  /index.html                       (rewrite, not redirect)
//   /markets              →  /markets.html                     (pretty URLs)
//
// Behind an origin access control S3 has no notion of a directory index, so
// without these rewrites every path that is not an exact object key would come
// back 403. Relative fetches on the pages ("data/metrics.json") still resolve
// correctly under the pretty URLs because the site lives at the domain root.
//
// Both .html and the extensionless form are reachable object keys, which is two
// addresses for one page. The pages carry <link rel="canonical"> pointing at the
// extensionless form; these redirects say the same thing to crawlers that do not
// read it, and collapse the wrong host and the wrong path into a single hop
// rather than two chained ones.
//
// One consequence worth knowing: a Google Search Console HTML verification file
// (google<token>.html) would be redirected away from the URL the verifier asks
// for. Verify by DNS TXT or by meta tag instead — docs/seo.md covers both.
// Bing's BingSiteAuth.xml is unaffected, and so is anything else with a
// non-.html extension.
//
// The CloudFront Functions runtime is not full modern JS — no `includes`,
// `startsWith`, or template literals — hence the index arithmetic.

var HTML = ".html";
var INDEX = "/index.html";

function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : "";
  var uri = request.uri;

  var wrongHost = host.indexOf("www.") === 0;
  var canonical = canonicalPath(uri);

  if (wrongHost || canonical !== uri) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: {
          value:
            "https://" +
            (wrongHost ? host.substring(4) : host) +
            canonical +
            queryString(request.querystring),
        },
      },
    };
  }

  if (uri.charAt(uri.length - 1) === "/") {
    request.uri = uri + "index.html";
    return request;
  }

  // Only the last segment matters: "/assets/viz.js" has an extension,
  // "/markets" does not.
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (lastSegment.indexOf(".") === -1) {
    request.uri = uri + HTML;
  }

  return request;
}

// The address a page should be read at: no .html suffix, and no index segment.
// "/foo/index.html" and "/foo/" are the same page, and both keep the slash.
function canonicalPath(uri) {
  if (endsWith(uri, INDEX)) {
    return uri.substring(0, uri.length - INDEX.length + 1);
  }

  if (endsWith(uri, HTML)) {
    return uri.substring(0, uri.length - HTML.length);
  }

  return uri;
}

function endsWith(value, suffix) {
  return (
    value.length >= suffix.length &&
    value.substring(value.length - suffix.length) === suffix
  );
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
