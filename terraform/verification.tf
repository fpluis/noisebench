# Search-engine ownership proofs, published as DNS records.
#
# Both are empty by default, so a plan run without them changes nothing. Fill
# them in terraform.tfvars once the consoles hand out the tokens — docs/seo.md
# walks through where each one comes from.
#
# DNS rather than a file at the site root, because the CloudFront function
# redirects /<token>.html to /<token> and Google's file check wants the exact
# URL. It also buys the stronger property in Search Console: a Domain property
# covers www, the apex, and every subdomain at once, where a file or a meta tag
# only proves the one origin.

variable "site_verification_txt" {
  description = <<-EOT
    TXT values to publish at the apex, one per verifier — for example
    "google-site-verification=xxxxxxxx". They share a single record set because
    a zone may hold only one TXT record per name.
  EOT
  type        = list(string)
  default     = []
}

variable "bing_verification_cname" {
  description = <<-EOT
    Bing Webmaster Tools' CNAME token: the label it asks you to point at
    verify.bing.com, without the domain. Empty publishes no record. Leave it
    empty if you verify Bing by importing the Search Console property, which is
    the one-click path and needs no DNS at all.
  EOT
  type        = string
  default     = ""
}

resource "aws_route53_record" "site_verification" {
  count = length(var.site_verification_txt) > 0 ? 1 : 0

  zone_id = data.aws_route53_zone.site.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 300
  records = var.site_verification_txt
}

resource "aws_route53_record" "bing_verification" {
  count = var.bing_verification_cname == "" ? 0 : 1

  zone_id = data.aws_route53_zone.site.zone_id
  name    = "${var.bing_verification_cname}.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = ["verify.bing.com"]
}
