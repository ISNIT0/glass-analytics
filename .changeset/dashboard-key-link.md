---

"dataflare-cli": patch
"dataflare-web": patch
---

The dashboard signs in from a link: `<host>/app#key=<key>` saves the key and wipes it from the address bar, so a QR code can sign a phone in without pasting. The key is in the URL fragment, which never reaches the server.
