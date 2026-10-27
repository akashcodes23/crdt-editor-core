# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## Security Model & Threat Model Boundaries

### Current Protections
* **SQL Injection**: All PostgreSQL queries utilize parameterized queries (`$1, $2, ...`) via `node-postgres` (`pg`), preventing SQL injection.
* **XSS Mitigation**: React DOM and Monaco Editor automatically escape plain-text code injections.
* **Denial of Service Limits**: Server enforces buffer size boundaries on incoming WebSocket messages.

### Deployment Assumptions
* Converge is currently designed to operate within a trusted network perimeter or behind an authenticating reverse proxy (e.g., NGINX, Cloudflare Access) that terminates TLS and provides rate limiting.
* Multi-tenant authorization (role-based editor/viewer permissions) is currently enforced at the room route boundary and requires reverse-proxy or session token integration for production environments.

---

## Reporting a Vulnerability

If you discover a security vulnerability in Converge, please report it privately:
* Email: [akashgpatil23.05@gmail.com](mailto:akashgpatil23.05@gmail.com)
* Please include reproduction steps, environment details, and potential impact.
* We will acknowledge receipt within 48 hours and coordinate a fix prior to public disclosure.
