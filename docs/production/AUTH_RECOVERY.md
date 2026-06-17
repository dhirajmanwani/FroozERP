# FroozERP Authentication And Account Recovery

Phase 3 keeps the existing backend `/login` endpoint as the authoritative authentication service for browser and installed Windows app logins.

## Login Compatibility

- Endpoint: `POST /login`
- Content type: `application/json`
- Required fields: `username`, `password`, `device_id`
- Device context fields: `device_name`, `device_type`, `user_agent`, `assigned_branch_id`, `assigned_counter_id`
- Username handling: trimmed and matched case-insensitively
- Password handling: compared against the existing secure hash; plain-text passwords are never stored
- Device approval: evaluated after credential validation

Safe backend error codes:

- `INVALID_CREDENTIALS`
- `USER_DISABLED`
- `DEVICE_PENDING_APPROVAL`
- `DEVICE_DISABLED`
- `DEVICE_REVOKED`
- `BRANCH_ACCESS_DENIED`
- `SERVER_UNAVAILABLE`

Public invalid-login messaging remains generic. `auth_audit_log` stores the safe diagnostic stage, for example `password_verification`, without storing passwords.

## Recovery Providers

OTP delivery is backend-only. The frontend and Tauri app do not contain email or SMS provider secrets.

Required production environment values:

- `RECOVERY_OTP_HASH_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `SMS_PROVIDER_URL`
- `SMS_PROVIDER_TOKEN` or `SMS_PROVIDER_API_KEY`
- `SMS_PROVIDER_METHOD`
- `SMS_PROVIDER_TEMPLATE`
- `SMS_SENDER_ID`
- `SMS_TEMPLATE_ID`

Development-only local testing:

- `RECOVERY_DEV_OTP_ENABLED=true`
- Must not be enabled in production

If no provider is configured, FroozERP reports that recovery delivery is not configured and does not claim real OTP delivery works.

## Recovery Data

Recovery requires an explicitly configured verified contact. Owners configure contacts from Profile / Recovery Security:

- `users.recovery_email`
- `users.recovery_email_verified`
- `users.recovery_email_verified_at`
- `users.pending_recovery_email`
- `users.recovery_mobile`
- `users.recovery_mobile_verified`
- `users.recovery_mobile_verified_at`
- `users.pending_recovery_mobile`
- Legacy fallback fields: `users.verified_email`, `users.verified_mobile`

Existing `email` and `mobile_number` fields are regular contact fields and are not automatically treated as verified recovery contacts.
User Management does not directly set verified recovery contacts. Verification must pass through `/auth/recovery/contact/request` and `/auth/recovery/contact/verify`.

Readiness report:

```sql
SELECT u.id, u.username, r.role_name, u.email, u.mobile_number
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE u.active = TRUE
  AND NOT (
    (COALESCE(u.recovery_email_verified, FALSE) = TRUE AND COALESCE(u.recovery_email, '') <> '')
    OR (COALESCE(u.recovery_mobile_verified, FALSE) = TRUE AND COALESCE(u.recovery_mobile, '') <> '')
    OR COALESCE(u.verified_email, '') <> ''
    OR COALESCE(u.verified_mobile, '') <> ''
  )
ORDER BY r.role_name, u.username;
```

## Recovery Endpoints

- `GET /auth/recovery/config`
- `GET /auth/recovery/profile`
- `POST /auth/recovery/contact/request`
- `POST /auth/recovery/contact/verify`
- `POST /auth/recovery/options`
- `POST /auth/recovery/send-otp`
- `POST /auth/recovery/verify-otp`
- `POST /auth/recovery/reset-password`
- `POST /users/:id/recovery-action`

The website and installed Windows app use these same backend endpoints.

## OTP Security

- Six-digit cryptographically secure OTP
- Approximately 10-minute expiry
- Single use
- Maximum verification attempts
- Resend cooldown
- Per-account request throttling
- OTP stored only as an HMAC hash
- Previous OTP invalidated when a new one is issued
- OTP and passwords are not logged
- Recovery events are written to `auth_audit_log`

## Staff Recovery

Staff self-recovery is disabled unless `staff_self_recovery_enabled` is enabled for that user. Otherwise staff see the Contact Owner / Administrator path.

Owner/Admin user management supports:

- Reset Staff Password
- Unlock Account
- Resend Username
- Disable User
- Revoke Sessions
- Require Password Change at Next Login

Existing passwords are never displayed.
