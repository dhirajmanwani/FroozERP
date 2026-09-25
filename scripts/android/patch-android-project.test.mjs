// node --test scripts/android/*.test.mjs
//
// The fixtures are the tauri-cli 2.11.2 Android templates (AndroidManifest.xml and
// app/build.gradle.kts) rendered the way `tauri android init` renders them for FroozERP. If a CLI
// upgrade changes their shape, the patch script refuses to guess; these tests pin that behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DATA_EXTRACTION_RULES_XML,
  REQUIRED_APPLICATION_ATTRIBUTES,
  patchGradle,
  patchManifest,
} from "./patch-android-project.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <!-- AndroidTV support -->
    <uses-feature android:name="android.software.leanback" android:required="false" />

    <application
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/Theme.froozerp"
        android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:launchMode="singleTask"
            android:label="@string/main_activity_title"
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <provider
          android:name="androidx.core.content.FileProvider"
          android:authorities="\${applicationId}.fileprovider"
          android:exported="false"
          android:grantUriPermissions="true">
          <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_paths" />
        </provider>
    </application>
</manifest>
`;

const GRADLE = `android {
    compileSdk = 36
    namespace = "com.srtcompany.froozerp"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.srtcompany.froozerp"
        minSdk = 24
        targetSdk = 36
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
`;

const applicationTag = (manifest) => manifest.match(/<application\b[^>]*>/)[0];
const debugCleartext = (gradle) => gradle
  .slice(gradle.indexOf('getByName("debug")'), gradle.indexOf('getByName("release")'))
  .match(/usesCleartextTraffic"\]\s*=\s*"(true|false)"/)[1];

test("manifest gets every backup / device-transfer switch on <application>", () => {
  const tag = applicationTag(patchManifest(MANIFEST));
  for (const [name, value] of REQUIRED_APPLICATION_ATTRIBUTES) {
    assert.ok(tag.includes(`${name}="${value}"`), `${name} missing`);
  }
  assert.ok(tag.includes('android:usesCleartextTraffic="${usesCleartextTraffic}"'));
  assert.ok(tag.endsWith('">'), "tag must stay a well-formed opening tag");
});

test("manifest patch is idempotent and only touches <application>", () => {
  const once = patchManifest(MANIFEST);
  assert.equal(patchManifest(once), once);
  const strip = (s) => s.replace(/<application\b[^>]*>/, "");
  assert.equal(strip(once), strip(MANIFEST));
});

test("manifest patch overrides an existing allowBackup=true instead of duplicating it", () => {
  const hostile = MANIFEST.replace('android:icon=', 'android:allowBackup="true"\n        android:icon=');
  const tag = applicationTag(patchManifest(hostile));
  assert.equal(tag.match(/android:allowBackup=/g).length, 1);
  assert.ok(tag.includes('android:allowBackup="false"'));
});

test("manifest patch refuses a hard-coded cleartext attribute or a missing manifest shape", () => {
  const hardcoded = MANIFEST.replace('"${usesCleartextTraffic}"', '"true"');
  assert.throws(() => patchManifest(hardcoded), /placeholder/);
  assert.throws(() => patchManifest("<manifest></manifest>"), /exactly one <application>/);
});

test("gradle: APK mode blocks cleartext in debug and release, dev mode re-allows debug only", () => {
  const apk = patchGradle(GRADLE);
  assert.equal(debugCleartext(apk), "false");
  assert.match(apk, /defaultConfig \{\n\s+manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  assert.equal(patchGradle(apk), apk, "idempotent");

  const dev = patchGradle(apk, { allowDevCleartext: true });
  assert.equal(debugCleartext(dev), "true");
  assert.match(dev, /defaultConfig \{\n\s+manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  assert.equal(patchGradle(dev, { allowDevCleartext: true }), dev, "idempotent");
  assert.equal(patchGradle(dev), apk, "switching back is exact");
});

test("gradle: defaultConfig cleartext is forced back to false", () => {
  const loosened = GRADLE.replace('"false"', '"true"');
  const out = patchGradle(loosened, { allowDevCleartext: true });
  assert.match(out, /defaultConfig \{\n\s+manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
});

test("gradle: refuses a template that sets cleartext on release or lacks the debug override", () => {
  const releaseOverride = GRADLE.replace(
    "isMinifyEnabled = true",
    'isMinifyEnabled = true\n            manifestPlaceholders["usesCleartextTraffic"] = "true"',
  );
  assert.throws(() => patchGradle(releaseOverride), /changed shape/);
  const noDebug = GRADLE.replace(/\s+manifestPlaceholders\["usesCleartextTraffic"\] = "true"/, "");
  assert.throws(() => patchGradle(noDebug), /changed shape/);
});

test("data extraction rules exclude every domain from cloud backup and device transfer", () => {
  for (const section of ["cloud-backup", "device-transfer"]) {
    const body = DATA_EXTRACTION_RULES_XML.split(`<${section}>`)[1].split(`</${section}>`)[0];
    for (const domain of ["root", "file", "database", "sharedpref", "external", "device_root"]) {
      assert.ok(body.includes(`<exclude domain="${domain}" path="." />`), `${section}/${domain}`);
    }
    assert.ok(!body.includes("<include"), `${section} must not include anything`);
  }
});
