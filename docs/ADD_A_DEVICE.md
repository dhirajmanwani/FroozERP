# Naya device jodna (phone, tablet, laptop)

Ye poora kaam aap khud kar sakte ho. Isme koi command nahi chalani.
Laptop pe FroozERP **1.0.75 ya usse naya** hona chahiye; 1.0.74 mein licence issue karte waqt
"device_id does not match the authenticated device session" aata tha.

## 1. Naye device pe app daalo

**Android phone ya tablet**
1. GitHub → FroozERP → **Actions** → left mein **Android build** → **Run workflow** → branch `main` → **Run workflow**.
2. Takriban 6 minute baad run hara (✓) ho jayega. Us run ko kholo → neeche **Artifacts** → `FroozERP-Android-debug-…` download karo.
3. Zip ko phone pe bhejo (WhatsApp/Drive), kholo, andar ki `.apk` pe tap karo.
4. Phone "unknown apps" ki permission maange to **Allow** → **Install**.
5. Phone pe FroozERP pehle se he to use pehle uninstall karo, warna naya install nahi hoga.

Artifact 7 din baad GitHub se hat jaata he. Tab dobara **Run workflow** kar lena.

**Windows laptop ya computer**
1. GitHub → FroozERP → **Releases** → sabse upar wala → `FroozERP-Setup-….exe` download karo.
2. Naye computer pe install karo.

## 2. Naye device pe: shop ko bhejo

1. App kholo. "Device Activation Required" screen aayegi.
2. **Step 1** mein apna username/password daalo → **Send to Shop**.
3. Hari line aayegi: "Sent. This device is now waiting at the shop."

## 3. Apne laptop pe: approve aur licence

1. **Branches & Counters** kholo → **Step 4 · Computers**. Naya device yahan dikhega
   (phone/tablet ka naam "Android Device …" hota he).
2. Counter, Kind of computer (Android Phone / Tablet / Laptop), user aur role chuno → **Approve Computer**.
3. **Settings → Device Activation Licences** kholo → wahi device select karo → Valid For chuno →
   **Issue Activation Licence** → **Copy File Text**.
4. Ye text WhatsApp pe khud ko bhejo.

## 4. Naye device pe: activate

1. WhatsApp se poora text copy karo.
2. App ke **Step 2** box mein paste karo → **Activate**.
3. Login karo.

(Windows computer pe **Save Activation File** karke `.lic` file bhi chun sakte ho.)

## Kuch galat ho to

| Screen pe likha | Kya karo |
| --- | --- |
| Username or password is wrong | Sahi username/password daal ke dobara Send to Shop. |
| Step 4 mein device nahi dikha | Branches & Counters band karke dobara kholo. Na dikhe to naye device pe Send to Shop dobara dabao aur uski line padho. |
| The shop's cloud could not be reached | Naye device ka internet check karo. |
| This activation file was issued for a different device | Licence galat device ke liye bana. Sahi device select karke dobara issue karo. |
| The activation signing key is not available on the server | Ye aapse theek nahi hoga; maintainer ko batao. |
| The Owner has blocked this device | Ye device pehle block kiya gaya tha. Maintainer ko batao. |
