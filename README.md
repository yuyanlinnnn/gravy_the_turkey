# HandsFree Pet — a hands-free "desktop pet" for any web page (Chrome / Edge extension)

A little 🦃 sits in the corner of every page. Move your head to steer a cursor, pinch to click,
use two hands to zoom, and talk to type into whatever text box is focused.

## Install (about 3 minutes)

1. **Download the assets once** (extensions can't load code from a CDN):
   - Mac/Linux: `bash get-assets.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File .\get-assets.ps1`

   This fills `vendor/` with the MediaPipe runtime and the hand + face models (~25 MB).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
3. A setup tab opens: click **Allow camera + microphone**.
4. Pin the 🦃 icon and click it to switch the pet **ON** (click again for OFF — that also turns the camera off).
5. Look at the middle of the screen for ~1.5 s so the cursor centres itself.

The first time you talk on a given website, Chrome asks for microphone access for **that site** (remembered after).

## Controls

| Action | How |
|---|---|
| Cursor | Move your head (nose position drives it). Speed: panel buttons or say "cursor faster / slower" |
| Click / place caret | Pinch thumb + index finger |
| Scroll | **One finger pointing up** = scroll up, **pointing down** = scroll down (the head no longer scrolls) |
| Zoom in / out | **Two open hands** apart = zoom in, together = zoom out |
| Keep the zoom | Show **two fists**: the size stays exactly where it is. Open both hands again to start a new zoom |
| Undo / redo | Swipe an open hand left / right, or say "undo" / "redo" |
| Type | Click where you want to write, then talk. Say "period", "comma", "question mark", "new line", "new paragraph" |

Click the turkey to open the settings panel (status, cursor speed, camera on/off, instructions).
The camera box (bottom-left) shows your face and hand landmarks; the pet and the camera box keep a constant size when the page zoom changes.

## Voice: typing mode vs. commands

Typing is **OFF** when the pet starts, so background chatter is never typed.

- **"gravy, start typing"** → typing ON. Now everything you say is typed (say "period", "comma", "question mark", "new line", "new paragraph" for punctuation).
- **"gravy, stop typing"** → typing OFF. Speech is ignored (the pet tells you so); gestures and gravy commands still work.
- The mode is remembered across pages and tabs.

Commands always start with **"gravy"** and work whether typing is on or off:

> "gravy, undo" · "gravy, redo" · "gravy, delete" (last word) · "gravy, delete that" (what I just dictated) · "gravy, select all"
> "gravy, bold / italic / underline" · "gravy, copy all" · "gravy, paste" · "gravy, zoom in" / "zoom out"
> "gravy, scroll down / up" · "gravy, click" · "gravy, enter" · "gravy, go back" · "gravy, recenter"
> "gravy, cursor faster / slower" · "gravy, help"

**Tabs and browsing** (Chrome's tab bar, + button and address bar can't be reached by any extension's cursor, so use your voice):

> "gravy, new tab" (opens Google next to this tab) · "gravy, next tab" · "gravy, previous tab" · "gravy, tab 2" · "gravy, close tab"
> "gravy, search for pumpkin pie recipes" · "gravy, open docs dot google dot com" (both open in a **new** tab so your document stays open) · "gravy, reload"

The pet follows you to the new tab (the page must be a normal website; Chrome's own pages like the empty New Tab page can't run it). Chrome asks for microphone access once per website.

Speech recognition often joins several phrases into one ("hello there gravy undo some more words"). Each piece is handled in order: text is typed, and after "gravy" the longest recognizable command is run; leftover words after it are typed again.

- Add a number to repeat: "gravy, undo three times", "gravy, delete word 2".
- Saying just "gravy" arms the next phrase as a command (useful if the recognizer splits them).
- An unknown "gravy, …" phrase is never typed; the pet says "Unknown command".

## Fast typing (low latency)

Chrome only calls a sentence "final" after you pause, which used to mean a 1–2 second wait before anything appeared.
Now the pet types words as soon as the recognizer has settled on them (unchanged across two updates, or quiet for ~0.45 s) and
adds only the missing words when the final result arrives. Phrases containing "gravy" always wait for the final result so a
command is never typed as text. Trade-off: very rarely the recognizer changes an already-typed word at the end (e.g. "right" → "write");
say "gravy, delete" to fix it, or turn **⚡ Fast typing** off in the panel to type only finished sentences.

## Typing works on every page

- If a text box is focused, the pet types into it quietly.
- If **nothing** is focused (for example right after "gravy, new tab"), the pet finds the page's search box or main text box, focuses it, and types there.
- If the page ignores script-made typing, or the box is inside an iframe, the pet switches to real browser input (the same method as Google Docs). Chrome then shows its "started debugging this browser" bar on that tab. Leave it alone.
- "gravy, enter" submits a search box; elsewhere it presses a real Enter key.
- Click the box yourself (pinch) if the page has several and the pet picked the wrong one.

## If typing "sometimes doesn't work"

Open the pet's panel (click the turkey) and read **Typing** and **Last typed**:

- **Typing: OFF** → say "gravy, start typing".
- **Last typed: ✗ extension was reloaded** → you reloaded the extension; refresh the page (Cmd+R).
- **✗ Another debugger is already attached** → close DevTools on that tab.
- Chrome's "started debugging" bar must stay (don't press Cancel). If you did, say "gravy, start typing" again or refresh the page.
- **Voice: off** → click the lock icon in the address bar and allow the microphone, then refresh.
- Only **one** copy of HandsFree Pet should be installed (remove old copies at chrome://extensions).

Drag the pet with a real mouse to move it.

## How it's built (what code you need)

```
 camera ─► offscreen.js ──► background.js ──► content.js (active tab)
          (engine: MediaPipe  (switchboard,     (pet UI, cursor, clicks,
           + gesture logic)    page zoom, on/off) speech, ADAPTERS)
```

| File | Job |
|---|---|
| `manifest.json` | Manifest V3: declares the service worker, the content script on all pages, the `offscreen` + `storage` permissions |
| `offscreen.html/.js` | The **engine**. A hidden page (the only place an MV3 extension can keep a camera open). Runs MediaPipe, turns landmarks into `cursor` / `click` / `undo` / `redo` / `zoom` messages |
| `background.js` | Service worker. Creates/destroys the engine, routes engine messages to the *active* tab, and does browser zoom (only extensions can) |
| `content.js` | Injected in every page inside a Shadow DOM. Draws the pet + cursor, performs clicks, runs speech recognition, edits text through **adapters** |
| `shared.js` | DOM-free logic used by both sides: command table, dictation formatter, cursor smoothing |
| `setup.html/.js` | One-time camera/mic permission page |
| `get-assets.*` | Downloads MediaPipe into `vendor/` |

### Adapting to other editing formats

All text editing goes through an **adapter** in `content.js` (`ADAPTERS` array). An adapter implements:
`match()` · `before()` (text left of the caret) · `insert(text)` · `undo()` · `redo()` · `selectAll()` ·
`deleteSel()` · `deleteWord()` · `goStart()` · `goEnd()` · `copyAll()`.

Included: `domAdapter` (inputs, textareas, any `contenteditable` — Gmail, Notion, Slack, Canvas, etc.)
and `docsAdapter` for Google Docs (real input via the background worker; add other canvas sites to `TRUSTED_HOSTS`).
To support a new editor (Monaco/VS Code web, CodeMirror, Word Online, a canvas editor…), write one adapter and
put it before `domAdapter` in the array. Nothing else changes.

Also easy to change: the pet (swap the 🦃 emoji for an image/sprite in `content.js`), gestures (all in `offscreen.js`),
and voice commands (the `COMMANDS` table in `shared.js`).

## Known limits (please read)

- **Untested on live hardware.** The content script, adapters, commands and message flow were tested with a stubbed Chrome API;
  the camera engine, MediaPipe-in-an-offscreen-document and the real extension install have **not** been run. Expect to tune
  cursor speed (`cursor faster/slower`) and gesture thresholds in `offscreen.js`.
- **Google Docs** is typed/clicked/scrolled with *real* browser input through Chrome's debugger interface (a "started debugging this browser" bar appears — don't press Cancel, and close DevTools on that tab). Unverified on live hardware.
- **Clicks elsewhere are synthetic.** Pages see them as script-generated events; most buttons/links work, but some sites ignore them.
  Native browser UI (address bar, tabs, `chrome://` pages, the Chrome Web Store, PDF viewer) cannot be reached by an extension.
- **Caret placement in `<input>`/`<textarea>`** goes to the end of the text (browsers don't expose caret-from-point there). Rich text places it where you point.
- **Google Docs / canvas editors** need their own adapter; the included one is a starting point.
- **Voice** uses Chrome's online speech service (needs internet) and asks for mic permission once per site.
- Only the **active tab** is controlled. Camera runs only while the pet is ON.
- Password fields are deliberately never dictated into.

## Uploading files (Canvas, Gmail, any “choose file” button)
The computer’s own file window can’t be used with a head cursor, so HandsFree replaces it with its own list.
- Click (pinch) any **upload / choose file** button → a big list of your files appears (no OS window).
- Pinch a file, or say **“gravy, file 2”**, or **“gravy, upload biology lab”** (any part of the name), **“gravy, cancel”** to close.
- “gravy, upload” opens the list for the upload button nearest your cursor.
- The list = everything you **downloaded with Chrome** (live) + recent files in **Desktop / Documents** (from `files.json`).
  To refresh the Desktop/Documents part: `cd ~/Desktop/handsfree-pet && bash refresh-files.sh`.
- The file is attached through the same “debugging” channel as Google Docs typing (keep the “started debugging” bar; don’t press Cancel).
- “Normal file window” button = the computer’s usual dialog, if you ever want it.

## The turkey walks around 🦃🚶
The pet strolls around the window, rests, and strolls again. It stands still while you drag it or while the settings panel is open.
- **“gravy, stay”** (or “stop walking”) — it stops where it is. **“gravy, walk”** — it starts again.
- Also the **🚶 Walking** button in the panel. “gravy” (alone) calls it back to its home corner.

## Assignment timer ⏱
Say **“gravy, there’s 30 minutes left for my assignment”** (also “I have 45 minutes left”, “set a timer for 20 minutes”, “an hour and a half left”).
- The turkey carries a clock (⏱ 29:05) on every tab, and it walks around with it. It turns orange under 15 minutes and red under 3.
- At **15 minutes** gravy says out loud: **“You better hurry up!”** At **3 minutes**: **“You’re cooked! Submit!”** At zero: “Time’s up! Submit it now!”
- “gravy, how much time is left” → gravy tells you. “gravy, cancel the timer” → clears it.
- The microphone is muted while gravy talks, so it never types its own voice. Turn your volume up!
- Gravy speaks like a funny, pompous male professor (British “Daniel” voice if your Mac has it). Say “gravy, change voice” to cycle through the other male voices installed.
- Voice styles: “gravy, chef voice” = a fast, impatient, furious-chef delivery (an original style, not any real person’s voice); “gravy, professor voice” goes back.
