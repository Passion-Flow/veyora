# Veyora preview user guide

Audience: end users of the preview.
Owner: documentation.

> [!CAUTION]
> Veyora is an experimental preview for inert test data. It is not approved
> for real credentials. Recovery, portable encrypted backup, atomic import,
> password change, connected authentication, offline behavior, and native
> installation are not supported claims yet.

## What is Veyora?

Veyora is intended to become a desktop-first encrypted Vault for one person,
with an advanced self-hosted connected mode. The current preview encrypts item
fields in the Rust/WASM security kernel before sending opaque record envelopes
to the service. This boundary depends on an uncompromised client, operating
system, build, and delivery path.

## Getting started

### First screen: choosing how to start

The first screen offers four routes before any password is requested:

- **Create a new vault** — start empty and add your first login.
- **Open an existing vault** — unlock a vault this device already knows.
  If no vault is known yet, Veyora says so instead of offering a browse.
- **Import from another password manager** — create a vault, then land in
  Settings → Data where the CSV import lives.
- **Advanced: connect to a self-hosted server** — sign in to a service you
  operate.

If the service requires authentication and no session exists, Veyora shows a
**Connect / Sign in** screen before vault creation or unlock. You enter the
service address and the connection token issued by your operator; the master
password is never involved in that step. The scoped, rotatable pairing of the
full connected mode is not available yet.

### Creating your vault

1. Open Veyora in your browser
2. Choose a **master password** (minimum 15 characters; use a long,
   memorable phrase)
3. Confirm the password
4. Click **Create vault**

> **Important**: The preview has no supported password recovery. If you forget
> the Master Password, current Vault data may be inaccessible. Use inert test
> data only.

### Recovery status

Recovery controls are disabled. Older previews may have shown
recovery-looking text, but that value does not unwrap the Vault Key that
encrypted existing items and must not be relied upon. A real Recovery Key will
return only after the clean-state non-empty-Vault recovery test passes.

### Unlocking

When you return, enter your master password to unlock. The password and
plaintext item fields remain in the client boundary; the connected client
fetches encrypted record envelopes from the service.

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

Type in the search box to filter entries. Search runs entirely on your
device against the entries already loaded and covers exactly these fields:
name, username, website, service, host, notes, secret, and the item type.
Your query is never sent to the service. Matching text is highlighted.
Press `Esc` to clear.

### Start here checklist

After you unlock a vault, a dismissible **Start here** card lists the first
safe steps: add or import your first login, copy or reveal a secret, and
lock the vault. Recovery verification and encrypted backup are listed as
unavailable in this preview. The card hides itself once the available steps
are done and can be reopened at any time from **Help → Open the Start here
checklist**.

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

After 5 minutes of inactivity (configurable in Settings), the Vault locks and
the active JavaScript key reference is released. This is not a guarantee that
every browser, WebView, operating-system, clipboard, or swap copy is erased.

### Clipboard protection

Veyora attempts to clear copied secrets after 30 seconds (configurable in
Settings). Clipboard managers and other processes may retain them.

### Master Password change

The current preview implementation is not atomic and is not a supported data
lifecycle. Do not use it with data you need to preserve. The target design will
rewrap an unchanged random Vault Key and prove rollback at every failure
boundary.

## Import and export

### Importing from CSV

Import credentials from other password managers:

1. Open **Settings → Data → Import CSV**
2. Select a CSV file with columns: `name,website,username,password,notes,tags_json`
3. Entries are encrypted and added to your vault

The current backend does not prove an all-or-nothing database transaction, so
partial results are possible. Use inert fixtures only and inspect the result.

### Exporting plaintext data

Open **Settings → Data → Export plaintext data**. The export is deliberately
gated:

1. An always-visible warning states that the file is **not encrypted** and that
   anyone who can open it can read every exported secret.
2. You must confirm you understand the warning and re-enter your master
   password; a wrong password exports nothing.
3. The completion view repeats **Not encrypted**, names the file, lists the
   included columns (name, type, website, username, password or secret,
   notes) and what is omitted (TOTP seeds, favorites, custom metadata), and
   tells you to move or delete the file safely.

**Create encrypted backup** is a separate action in the same section; it is
not available in this preview yet and is shown as unavailable rather than
pretending. Plaintext CSV is an interoperability escape hatch, never a
backup.

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

The same list is available in the app from the **Keyboard shortcuts**
button in the top bar and from **Help → Use keyboard shortcuts**.
Shortcuts never fire while focus is in a text field.

## Settings

| Setting | Options | Default |
|---------|---------|---------|
| Theme | Light / Dark | Light |
| Language | 10 languages | Auto-detect |
| Auto-lock | 1–30 minutes | 5 minutes |
| Clipboard clear | 10–60 seconds | 30 seconds |

## Offline status

Desktop Local is the intended offline-by-design mode. The full per-mode
capability picture — Desktop Local, Desktop Connected, and Web Connected —
is documented in the mode matrix (). Connected Web offline
read/write, durability, reconnection, and conflict behavior have not passed the
required matrix, so no offline-access promise is made for this preview.

## Privacy

- **No tracking**: Veyora contains no analytics or telemetry
- **No third parties**: fonts and scripts are self-hosted
- **Content Security Policy**: a Web policy exists, but response and desktop
  enforcement still require release evidence
- **Bounded client encryption**: the service is intended to receive opaque
  record envelopes, but a compromised client, build, endpoint, or delivery path
  can expose plaintext

## Troubleshooting

**"Decryption failed — wrong master password"**
Your password doesn't match the Vault's encryption key. Check the password and
preserve the current Vault unchanged; the preview has no supported recovery
path.

**"Sync failed — check the API connection"**
The server is unreachable. Check your network connection and the
server status.

**I forgot my master password**
Do not reset or overwrite the Vault. The preview has no supported Recovery Key
flow. Preserve the opaque storage unchanged for a future reviewed migration or
recovery tool.

**The vault is empty after unlocking**
If you recently cleared the server database, your entries are gone.
Do not assume the current opaque snapshot is a portable encrypted backup.
Restore only from independently verified test evidence, or re-import inert data
from a plaintext CSV after reviewing its exposure risk.
