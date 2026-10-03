import assert from "node:assert/strict";
import test from "node:test";
import { WHATSAPP_OPENED, describeChatHandoff, initialWhatsappSelection } from "./whatsappHandoff.js";

test("a bill's single customer with a number is preselected", () => {
  const picked = initialWhatsappSelection([{ key: "customer-1-98", phoneNumber: "9876543210", optIn: true }]);
  assert.deepEqual([...picked], ["customer-1-98"]);
});

test("nothing is preselected for several names, no number, or an opted-out customer", () => {
  assert.equal(initialWhatsappSelection([{ key: "a", phoneNumber: "1" }, { key: "b", phoneNumber: "2" }]).size, 0);
  assert.equal(initialWhatsappSelection([{ key: "a", phoneNumber: "" }]).size, 0);
  assert.equal(initialWhatsappSelection([{ key: "a", phoneNumber: "9876543210", optIn: false }]).size, 0);
  assert.equal(initialWhatsappSelection(null).size, 0);
});

test("the hand-off message claims only what happened", () => {
  const ok = describeChatHandoff({ opened: WHATSAPP_OPENED.APP, copied: true, name: "Ramesh", fileName: "Bill.pdf" });
  assert.equal(ok.tone, "ok");
  assert.match(ok.text, /chat with Ramesh/);
  assert.match(ok.text, /Ctrl\+V/);
  const notCopied = describeChatHandoff({ opened: WHATSAPP_OPENED.APP, copied: false, fileName: "Bill.pdf" });
  assert.equal(notCopied.tone, "warning");
  assert.doesNotMatch(notCopied.text, /Ctrl\+V/);
  assert.match(notCopied.text, /Bill\.pdf/);
  const browser = describeChatHandoff({ opened: WHATSAPP_OPENED.BROWSER, copied: true });
  assert.match(browser.text, /browser/);
  const failed = describeChatHandoff({ opened: "", copied: false, fileName: "Bill.pdf", error: "no app" });
  assert.equal(failed.tone, "error");
  assert.match(failed.text, /no app/);
  assert.match(describeChatHandoff({ opened: "app", copied: true, others: 2 }).text, /other 2/);
});

const appSource = (await import("node:fs")).readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const rust = (await import("node:fs")).readFileSync(new URL("../../../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("the send window hands off to WhatsApp Desktop only in the Windows app, and only as a fallback", () => {
  const start = appSource.indexOf("const handOffToWhatsappDesktop = async (pdfResult, fileName) => {");
  assert.ok(start > 0);
  const body = appSource.slice(start, appSource.indexOf("const send = async () => {", start));
  assert.match(body, /if \(!isDesktopShell\(\) \|\| MOBILE_SHELL \|\| !pdfResult\?\.blob\) return false;/);
  assert.match(body, /invokeTauriCommand\("copy_file_to_clipboard"/);
  assert.match(body, /invokeTauriCommand\("open_whatsapp_chat", \{ phone, text: caption \|\| "" \}\)/);
  // The Business API is still tried first; the hand-off only replaces the old wa.me fallback.
  const send = appSource.slice(appSource.indexOf("const send = async () => {", start), appSource.indexOf("return (", start));
  assert.ok(send.indexOf("/api/whatsapp/send-document") < send.indexOf("handOffToWhatsappDesktop("));
  assert.match(appSource, /useState\(\(\) => initialWhatsappSelection\(recipients\)\)/);
});

test("the Rust commands exist, are registered, and only ever build WhatsApp links from checked input", () => {
  for (const command of ["open_whatsapp_group", "open_whatsapp_chat", "copy_file_to_clipboard"]) {
    assert.match(rust, new RegExp(`fn ${command}\\(`));
    assert.match(rust, new RegExp(`\\n\\s+${command},\\n`), `${command} must be in generate_handler!`);
  }
  assert.match(rust, /whatsapp_invite_code_is_valid\(code\)/);
  assert.match(rust, /whatsapp_phone_is_valid\(phone\)/);
  assert.match(rust, /"whatsapp:\/\/chat\/\?code=\{\}"/);
  assert.match(rust, /"whatsapp:\/\/send\?phone=\{\}&text=\{\}"/);
});
