import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");

test("every password box has FroozERP's own eye, so a refused sign-in never hides it", () => {
  // The only raw password inputs left are the two that already carry a "Show password" checkbox.
  const raw = app.match(/<input[^>]*type="password"/g) || [];
  assert.deepEqual(raw, [], "a plain password <input> would fall back to the WebView's vanishing eye");
  assert.match(app, /Password\s*<PasswordInput\s+value=\{password\}/, "the sign-in screen uses it");
  assert.ok((app.match(/<PasswordInput\b/g) || []).length >= 17);
});

test("the eye starts hidden, keeps what was typed, and stays out of the Tab order", () => {
  const start = app.indexOf("function PasswordInput(");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(body, /useState\(false\)/);
  assert.match(body, /<input \{\.\.\.props\} type=\{shown \? "text" : "password"\} \/>/);
  assert.match(body, /tabIndex=\{-1\}/);
  assert.match(body, /type="button"/, "never a submit button inside a form");
  assert.match(body, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/, "clicking it keeps the cursor in the box");
  assert.doesNotMatch(body, /onChange|props\.value|target\.value/, "it never touches the password itself");
});

test("the WebView's own reveal eye is hidden beside ours", () => {
  assert.match(css, /\.password-field > input::-ms-reveal,\s*\.password-field > input::-ms-clear \{\s*display: none;/);
});
