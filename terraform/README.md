# Hosting

`noisebench.com` is a static site: three HTML pages, one JS bundle, one
stylesheet, and about 300 KB of JSON that `scripts/analyze.ts` writes into
`site/data/`. There is no build step and no backend, so hosting is a bucket
behind a CDN.

```
GitHub push to master (site/** changed)
  └─ .github/workflows/deploy.yml
       ├─ assume noisebench-com-site-deploy via OIDC   (no stored AWS keys)
       ├─ aws s3 sync site/ → S3 bucket (private)
       └─ CloudFront invalidation "/*"

visitor → Route53 alias → CloudFront → OAC-signed read → S3
                            │
                            ├─ viewer-request function: www→apex, /markets→/markets.html
                            └─ response headers policy: HSTS, CSP, frame-options
```

## Caching

Objects go up with `public, max-age=300, s-maxage=31536000`, and every deploy
invalidates `/*`. CloudFront holds the content until a deploy explicitly clears
it; a browser holds it for at most five minutes. This matters because
`site/data/*.json` is overwritten in place — the file names never change, so
there is no cache-busting hash to rely on.
