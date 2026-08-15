# Veyora User Guide

## What is Veyora?

Veyora is a private digital vault for your credentials. Your passwords,
API tokens, SSH keys, and secure notes are encrypted in your browser
before they ever leave your device. The server stores only unreadable
ciphertext — not even the server operator can see your data.

## Getting started

### Creating your vault

1. Open Veyora in your browser
2. Choose a **master password** (minimum 8 characters; use a long,
   memorable phrase)
3. Confirm the password
4. Check the acknowledgment box
5. Click **Create vault**

> **Important**: Your master password cannot be recovered. If you forget
> it AND lose your recovery kit, your data is permanently inaccessible.

### The recovery kit

After creating your vault, you'll see a **recovery kit** — a code like
`cuptr-ufyb4-sseb3-...`. This is the only way to regain access if you
forget your master password.

**Save it somewhere safe offline:**
- Write it on paper and store it in a secure location
- Or click **Download .txt** and store the file on encrypted media

Anyone with this code can access your vault, so treat it like a master
key.

### Unlocking

When you return, enter your master password to unlock. Your entries are
decrypted locally in your browser — nothing is transmitted.

## Managing entries

### Creating an entry

1. Click **New entry** (or press `Ctrl+N`)
2. Choose a template:
   - **Login**: username, password, website, TOTP secret
   - **Secure note**: free-form encrypted text
   - **API token**: service name + token
   - **SSH key**: hostname + private key
   - **Identity**: full name + ID number
3. Fill in the fields
4. Click **Create entry**

### Password generator

Click **Gen** next to any password field to open the generator:

- Adjust the **length** (12–64 characters)
- Toggle character sets (uppercase, lowercase, digits, symbols)
- Enable **"Avoid ambiguous characters"** to skip lookalikes (I/l/1/O/0)
- Click **Use this password** to fill the field

### Two-factor authentication (TOTP)

If a website gives you a TOTP secret (usually a Base32 string like
`JBSWY3DPEHPK3PXP`), paste it into the **TOTP secret** field on a login
entry. Veyora will show a live 6-digit code with a countdown timer in
the entry detail view.

### Editing

Click any entry to open its detail panel, then click **Edit**. Changes
are re-encrypted and stored with a new revision number.

### Deleting and the trash

Click **Delete**, then click again to confirm. Deleted entries move to
the **Trash** tab. To recover:

1. Click the **Trash** tab
2. Find the entry
3. Click the **restore** button (↻)

Entries stay in the trash until the server administrator purges them.

## Organizing your vault

### Favorites

Click the ★ icon on any entry to mark it as a favorite. Favorites get
their own tab for quick access.

### Search

Type in the search box to filter entries by name, username, website, or
notes. Matching text is highlighted. Press `Esc` to clear.

### Sorting

Use the dropdown to sort by name (A–Z, Z–A), recently updated, or type.
Your choice is remembered.

### Type tabs

The tabs above the table filter entries by type. Click **All items** to
see everything.

## Security features

### Password health

Veyora analyzes your vault locally and warns about:

- **Reused passwords** (⚠️ badge): the same password on multiple entries
- **Stale passwords** (🕐 badge): not changed in over 180 days

The toolbar shows aggregate counts (e.g., "3 reused · 2 stale").

### Auto-lock

After 5 minutes of inactivity (configurable in Settings), the vault
locks automatically and the encryption key is cleared from memory.

### Clipboard protection

Copied secrets are automatically cleared from your clipboard after 30
seconds (configurable in Settings).

### Master password rotation

To change your master password:

1. Open **Settings** (gear icon)
2. Under **Security**, click **Change master password**
3. Enter your current password, then the new password twice
4. Click **Save**

All entries are re-encrypted under the new password. This may take a
moment for large vaults.

## Import and export

### Importing from CSV

Import credentials from other password managers:

1. Open **Settings → Data → Import CSV**
2. Select a CSV file with columns: `name,website,username,password,notes,tags_json`
3. Entries are encrypted and added to your vault

The import is **all-or-nothing**: if any row is malformed, nothing is
imported.

### Exporting to CSV

Open **Settings → Data → Export CSV** to download all entries as a
plaintext CSV file. **Handle the file with care** — it contains your
decrypted passwords.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New entry |
| `Ctrl+G` | Password generator |
| `Ctrl+K` or `Ctrl+F` | Focus search |
| `Ctrl+L` | Lock vault |
| `j` / `↓` | Next entry |
| `k` / `↑` | Previous entry |
| `Enter` | Open selected entry |
| `Esc` | Close dialog / clear search |

## Settings

| Setting | Options | Default |
|---------|---------|---------|
| Theme | Light / Dark | Light |
| Language | 10 languages | Auto-detect |
| Auto-lock | 1–30 minutes | 5 minutes |
| Clipboard clear | 10–60 seconds | 30 seconds |

## Offline access

Veyora caches its interface for offline use. You can browse your vault
and view entries even without an internet connection (changes sync when
you reconnect).

## Privacy

- **No tracking**: Veyora contains no analytics or telemetry
- **No third parties**: fonts and scripts are self-hosted
- **Content Security Policy**: strict CSP blocks unauthorized scripts
- **Zero knowledge**: the server cannot read your data under any
  circumstances

## Troubleshooting

**"Decryption failed — wrong master password"**
Your password doesn't match the vault's encryption key. Try again or
use the recovery kit.

**"Sync failed — check the API connection"**
The server is unreachable. Check your network connection and the
server status.

**I forgot my master password**
Use the recovery kit you saved during setup. Go to the unlock screen
and click **"Lost the password? Recover with the kit"**.

**The vault is empty after unlocking**
If you recently cleared the server database, your entries are gone.
Restore from a backup or re-import from a CSV export.
