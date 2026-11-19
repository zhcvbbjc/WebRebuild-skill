# Authentication and Sessions

Use this reference when a site requires login, account access, OTP, QR confirmation, CAPTCHA, or third-party sign-in.

## Detection

The crawler records:

- Requested URL and final login URL.
- Visible field labels, types, names, required flags, and autocomplete hints.
- Password, one-time-code, CAPTCHA, QR, and OAuth indicators.
- Redirected routes that prove a section is gated.

Treat a login page or gated route as an evidence gap until an authorized session is available.

## What to Ask the User

Report only what the site actually asks for. A useful question is:

> 站点要求登录。检测到账号字段“请输入账号”、密码字段、验证码字段，并可能提供扫码/第三方登录。请选择在本机打开的浏览器中手动完成登录，或提供已有授权会话文件。请勿在聊天中发送密码、验证码或 Cookie。

Do not ask for raw passwords, one-time codes, recovery codes, cookies, or bearer tokens in chat. Do not ask the user to weaken security settings, disable MFA, or bypass CAPTCHA.

Ask for a decision when the login method is ambiguous:

- Complete login manually in the headed browser.
- Provide a previously authorized Playwright storage-state file.
- Exclude authenticated routes from the current reconstruction.

Use `user choice` only when it materially changes access to required routes. Otherwise continue with public scope and mark account areas incomplete.

## Manual Login

Run:

```bash
node scripts/capture_auth_state.mjs \
  --url "https://example.com/login" \
  --out ".web-rebuild-private/auth-state.json" \
  --channel chrome
```

The user completes password, QR, OTP, CAPTCHA, or third-party authentication in the browser. After the authenticated account page is visible, the user presses Enter in the terminal. The script saves Playwright storage state and does not print cookies or page contents.

Treat the storage-state file as a credential:

- Keep it outside the evidence tree.
- Do not commit, attach, upload, or quote it.
- Do not include it in model context or logs.
- Delete it when the task no longer needs it, unless the user explicitly wants to retain it.

## Resume

```bash
node scripts/reverse_site.mjs \
  --url "https://example.com/" \
  --out web-rebuild-output \
  --storage-state ".web-rebuild-private/auth-state.json" \
  --max-pages 1000 \
  --resume
```

Then verify:

- Previously gated routes no longer redirect to login.
- Authenticated account content is not mistaken for public content.
- Logout and expired-session behavior are understood.
- Personal values are excluded from generated fixtures and screenshots used for delivery.

If the session expires or is rejected, stop and request a fresh authorized session. Do not attempt to bypass the gate.

## Local Reconstruction

Authentication flows must be rebuilt as a local authorization boundary, not by embedding the original site's cookies or calling its private account endpoints.

Decide explicitly:

- Reproduce the login UI with a local auth service.
- Integrate an auth provider the user controls.
- Provide a clearly labeled demo session.
- Exclude account functionality from the agreed deliverable.

Never ship recovered credentials or private session data in client code.
