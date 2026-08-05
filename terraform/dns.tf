data "aws_route53_zone" "site" {
  name         = "${var.domain_name}."
  private_zone = false
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for option in aws_acm_certificate.site.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id = data.aws_route53_zone.site.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # The apex and www validation records collapse to the same name when the
  # certificate covers both; without this the second one errors.
  allow_overwrite = true
}

locals {
  # Both hostnames need an A and an AAAA alias — CloudFront is dual-stack and a
  # v6-only client gets nothing from the A record alone.
  alias_records = {
    for pair in setproduct([var.domain_name, "www.${var.domain_name}"], ["A", "AAAA"]) :
    "${pair[0]}-${pair[1]}" => {
      host = pair[0]
      type = pair[1]
    }
  }
}

resource "aws_route53_record" "site" {
  for_each = local.alias_records

  zone_id = data.aws_route53_zone.site.zone_id
  name    = each.value.host
  type    = each.value.type

  # Alias records to CloudFront are free to query and, unlike a CNAME, legal at
  # the zone apex.
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
