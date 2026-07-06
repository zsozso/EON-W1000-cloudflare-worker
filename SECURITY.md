# Security Policy

## Supported Versions

We only support security updates for the latest version on the `main` branch.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**DO NOT create a public GitHub issue for security-related topics.** 

If you discover a security vulnerability (such as credential leaks, security bypasses, or potential exploits in the parsing logic), please report it privately:

We will acknowledge your report. Please allow us reasonable time to resolve the issue before making any public disclosure.

## Best Practices for Users

Since this project handles Home Assistant credentials and runs on Cloudflare Workers, please ensure you follow these safety guidelines:

* **Use Cloudflare Secrets:** Never hardcode your `HA_TOKEN` in the `wrangler.toml` file. Always use `wrangler secret put HA_TOKEN`.
* **Restrict Access:** Do not expose your Home Assistant API to the public internet without protection. Use a Cloudflare Tunnel with Access Policies, or restrict incoming API traffic by ASN (e.g., only allow Cloudflare Workers ASN: `AS13335`).
