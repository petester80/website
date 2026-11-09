/*
 * Published host for Card River.
 *
 * The counterpart to local-runtime.js. That one points the page at a folder on
 * your disk so you can author the piece; this one points it at the files
 * sitting beside it on a web server so a visitor can simply watch it.
 *
 *   ./card-river-state.json   the saved river, fetched once
 *   ./images/<id>             the pictures, by relative path
 *
 * It is read-only by construction: there is no folder picker, no write path
 * and no status pill. local-runtime.js asks for showDirectoryPicker first and
 * only falls back to fetching, which is right at your desk and wrong here --
 * in Chrome a visitor would be asked to choose a folder they do not have. So
 * the published build gets its own host rather than a flag on that one.
 */
(function () {
  'use strict';

  var STATE_FILE = 'card-river-state.json';
  var IMAGES_DIR = 'images';

  var docs = {};
  /* The river as it arrived. The page writes a few documents back while it
     starts up -- settling defaults, mostly -- so "has anything been set?" is
     true before a visitor has touched a thing, and the only honest test is
     whether what is in hand still matches what was served. */
  var baseline = '{}';
  var dirty = false;
  var onDirty = null;

  /* ?edit brings the editor's gear back. Nothing it does can be saved here --
     a static host has nowhere to write -- so this is for looking, not
     authoring: checking how a setting sits at a real width on a real device,
     where the answer is not quite what the desk says. Authoring happens in
     local.html. It is set before the page draws, not a secret, and guards
     nothing: it only keeps the gear out of a visitor's way. */
  if (/[?&]edit\b/.test(location.search)) {
    document.documentElement.setAttribute('data-edit', '');
  }

  /* The page holds its first frame until it knows what it is drawing. Here the
     pictures are ordinary URLs the browser fetches as it draws them, so there
     is nothing to wait for and saying so is what lets the river start. */
  window.__assetsPending = false;
  window.__onAssetsReady = function (cb) { cb(); };

  /* Not 'pick' or 'reconnect': those two make the page draw nothing and say
     what it is waiting for, which is the right answer at your desk and a
     blank screen on a website. */
  window.__folderState = 'served';

  /* An id is a filename in images/. No blob URLs, because nothing was read
     into memory -- the browser fetches each picture when the card needs it. */
  /* A picture uploaded a moment ago is committed but not yet served: Pages
     takes about a minute. Until then it is shown from memory, so adding one
     does not mean staring at a broken card while a build runs. */
  var freshById = new Map();

  window.__resolveAsset = function (id) {
    return freshById.get(id) || (IMAGES_DIR + '/' + encodeURIComponent(id));
  };

  var db = {
    doc: function (path) {
      return {
        get: async function () {
          return {
            exists: Object.prototype.hasOwnProperty.call(docs, path),
            data: function () { return docs[path]; },
          };
        },
        /* Held in memory, which is as long as a visitor's tab lasts. With
           ?edit and a token it can go further: see publishing, below. */
        set: async function (data) {
          docs[path] = JSON.parse(JSON.stringify(data));
          var now = JSON.stringify(docs);
          if ((now !== baseline) === dirty) return;   // nothing to announce
          dirty = now !== baseline;
          if (onDirty) onDirty(dirty);
        },
      };
    },
  };

  var booted = (async function () {
    try {
      var r = await fetch('./' + STATE_FILE, { cache: 'no-store' });
      if (r.ok) docs = (await r.json()) || {};
      baseline = JSON.stringify(docs);
    } catch (e) {
      /* No state file, or a server that would not give it up. The page has a
         sample river of its own for exactly this, so let it show that rather
         than nothing at all. */
    }
    return document.documentElement.hasAttribute('data-edit')
      ? { db: db, assets: assets }
      : { db: db };
  })();

  /* ---------- adding pictures, with ?edit ------------------------------

     Same route as publishing: the page cannot write to the server it came
     from, so it asks GitHub to commit the file and Pages serves it a minute
     later. Until then the card is drawn from memory.

     Pictures are shrunk on the way up. The backdrop is drawn across the whole
     frame and wants the pixels; a card is a few hundred across and does not,
     and a phone photograph is several thousand. 2400 is the compromise: more
     than the backdrop has had until now, far less than a modern camera makes.

     JPEG unless the picture has transparency, because a cut-out with its
     background filled in is not the same picture. */

  var IMG_MAX = 2400;         // longest side, in pixels
  var IMG_QUALITY = 0.84;
  var UPLOAD_CAP = 8 * 1024 * 1024;

  function tooLarge() {
    var e = new Error('That file is too big to publish');
    e.code = 'too_large';
    return e;
  }

  /* Does any pixel let the background through? Worth the one pass: encoding a
     cut-out as JPEG fills its transparency with black. */
  function hasAlpha(ctx, w, h) {
    var d = ctx.getImageData(0, 0, w, h).data;
    for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }

  async function shrink(file) {
    if (!/^image\//.test(file.type) || /svg/.test(file.type)) return file;
    var bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      return file;              // a format this browser will not decode
    }
    var scale = Math.min(1, IMG_MAX / Math.max(bmp.width, bmp.height));
    var w = Math.max(1, Math.round(bmp.width * scale));
    var h = Math.max(1, Math.round(bmp.height * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();

    var keepAlpha = /png|webp|gif/.test(file.type) && hasAlpha(ctx, w, h);
    var type = keepAlpha ? 'image/png' : 'image/jpeg';
    var out = await new Promise(function (done) {
      cv.toBlob(done, type, keepAlpha ? undefined : IMG_QUALITY);
    });
    if (!out) return file;
    // a small picture re-encoded can come out larger; keep whichever is smaller
    return out.size < file.size ? out : file;
  }

  async function commitFile(t, path, blob, message) {
    var repo = repoFromUrl();
    if (!repo) throw new Error('Not a GitHub Pages URL');
    var api = 'https://api.github.com/repos/' + repo + '/contents/' + path;
    var head = headersFor(t);

    var sha;
    var got = await fetch(api + '?ref=HEAD', { headers: head, cache: 'no-store' });
    if (got.status === 401) throw new Error('Token refused');
    if (got.ok) sha = (await got.json()).sha;

    var bytes = new Uint8Array(await blob.arrayBuffer());
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    var put = await fetch(api, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, head),
      body: JSON.stringify({ message: message, content: btoa(bin), sha: sha }),
    });
    if (put.status === 403) {
      throw new Error('Token cannot write here \u2014 set Contents: read and write');
    }
    if (!put.ok) throw new Error(await why(put, 'GitHub said ' + put.status));
  }

  var assets = {
    upload: async function (file) {
      var t = await token();
      if (!t) throw new Error('No token \u2014 press Publish to add one');

      var blob = await shrink(file);
      if (blob.size > UPLOAD_CAP) throw tooLarge();

      /* The same naming as the folder on disk: a sortable prefix so two
         pictures of the same name cannot collide, and the original name kept
         so the folder stays readable. */
      var base = String(file.name || 'picture').replace(/[^\w.-]+/g, '-');
      if (blob !== file && blob.type === 'image/jpeg') base = base.replace(/\.[^.]+$/, '') + '.jpg';
      if (blob !== file && blob.type === 'image/png') base = base.replace(/\.[^.]+$/, '') + '.png';
      var id = Date.now().toString(36) + '-' + base;

      await commitFile(t, IMAGES_DIR + '/' + id, blob, 'Add ' + id + ' from the live page');

      var url = URL.createObjectURL(blob);
      freshById.set(id, url);
      return { id: id, url: url, sizeBytes: blob.size, contentType: blob.type };
    },

    delete: async function (id) {
      var u = freshById.get(id);
      if (u) { URL.revokeObjectURL(u); freshById.delete(id); }
      var t = null;
      try { t = localStorage.getItem(TOKEN_KEY); } catch (e) {}
      if (!t) return { deleted: false };     // never ask for a token to tidy up
      var repo = repoFromUrl();
      if (!repo) return { deleted: false };
      var api = 'https://api.github.com/repos/' + repo + '/contents/'
        + IMAGES_DIR + '/' + encodeURIComponent(id);
      var head = headersFor(t);
      try {
        var got = await fetch(api + '?ref=HEAD', { headers: head, cache: 'no-store' });
        if (!got.ok) return { deleted: false };
        var sha = (await got.json()).sha;
        await fetch(api, {
          method: 'DELETE',
          headers: Object.assign({ 'Content-Type': 'application/json' }, head),
          body: JSON.stringify({ message: 'Remove ' + id + ' from the live page', sha: sha }),
        });
      } catch (e) { /* a picture that will not go is not worth stopping for */ }
      return { deleted: true };
    },
  };

  /* ---------- publishing, with ?edit ----------------------------------

     A static host has nowhere to write, so the page cannot save to the server
     it came from. It can, though, ask GitHub to commit the state file for it,
     which is the same thing one step removed: the commit lands, Pages
     rebuilds, and a minute later every visitor has it.

     That needs a token with write access to the repository, and the only
     place to keep it here is this browser. So: make it a fine-grained token
     for this one repository, give it Contents write and nothing else, and set
     it to expire. It is stored under the origin, and a GitHub user site is
     one origin for every project under it -- so anything else you ever
     publish to petester80.github.io could read it.

     Pictures are not covered. images/ is written by the build on your Mac,
     and the live page has no uploader at all, so this publishes arrangement,
     words and settings -- not new photographs. */

  var TOKEN_KEY = 'card-river-publish-token';

  /* Uploading needs the token as much as publishing does, and the asking for
     it lives in the button down below. So the ask is registered rather than
     reached for, and anything that needs a token goes through here. */
  var askForToken = null;

  async function token() {
    var t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch (e) { /* private window */ }
    if (t) return t;
    if (!askForToken) return null;
    t = await askForToken();
    if (t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
    return t;
  }

  function headersFor(t) {
    return { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' };
  }

  /* Which repository this page came out of, read off the URL rather than
     written in, so the file does not have to know whose site it is on.
       petester80.github.io/website/  ->  petester80/website
       petester80.github.io/          ->  petester80/petester80.github.io */
  function repoFromUrl() {
    var owner = location.hostname.replace(/\.github\.io$/, '');
    var first = location.pathname.split('/').filter(Boolean)[0];
    if (!owner || location.hostname === owner) return null;
    return owner + '/' + (first || location.hostname);
  }

  // btoa is bytes, not characters, and the state file has none of the former
  function b64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* GitHub explains itself in the body, and that explanation is nearly always
     more use than the number in front of it. */
  async function why(res, fallback) {
    try {
      var body = await res.json();
      if (body && body.message) return body.message;
    } catch (e) { /* not JSON */ }
    return fallback;
  }

  async function commitState(token) {
    var repo = repoFromUrl();
    if (!repo) throw new Error('Not a GitHub Pages URL');
    var api = 'https://api.github.com/repos/' + repo + '/contents/' + STATE_FILE;
    var head = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
    };

    /* The current file's sha, which GitHub wants as proof you are replacing
       the version you think you are. Without it a stale tab would quietly
       overwrite a newer commit. */
    var sha;
    var got = await fetch(api + '?ref=HEAD', { headers: head, cache: 'no-store' });
    if (got.status === 401) throw new Error('Token refused');
    if (got.status === 404) throw new Error('No access to ' + repo);
    if (!got.ok && got.status !== 404) throw new Error(await why(got, 'Could not read the repo'));
    if (got.ok) sha = (await got.json()).sha;

    var put = await fetch(api, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, head),
      body: JSON.stringify({
        message: 'Publish from the live page',
        content: b64(JSON.stringify(docs, null, 2)),
        sha: sha,
      }),
    });
    if (put.status === 409) throw new Error('Someone else published first');
    if (put.status === 403) {
      /* A token that authenticates but may not write. Nearly always the
         token's own doing: "Public repositories (read-only)" under repository
         access, or Contents left at read. Said plainly, because "GitHub said
         403" sends you looking in the wrong place. */
      throw new Error('Token cannot write here \u2014 set Contents: read and write');
    }
    if (!put.ok) throw new Error(await why(put, 'GitHub said ' + put.status));
    baseline = JSON.stringify(docs);
    dirty = false;
  }

  /* ---------- the button ---------- */

  function publishUi() {
    var bar = document.createElement('div');
    bar.style.cssText = [
      'position:fixed', 'left:14px', 'bottom:14px', 'z-index:300',
      'display:flex', 'gap:8px', 'align-items:center',
      'padding:7px 11px', 'border-radius:999px',
      'border:1px solid rgba(232,236,246,.14)', 'background:rgba(10,14,26,.82)',
      'backdrop-filter:blur(14px)', 'color:#8b96ad',
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace',
      'max-width:min(360px, calc(100vw - 28px))',
    ].join(';');

    var say = document.createElement('span');
    say.textContent = 'No changes yet';
    bar.appendChild(say);

    var go = document.createElement('button');
    go.textContent = 'Publish';
    go.disabled = true;
    go.style.cssText = [
      'border:1px solid rgba(232,236,246,.2)', 'background:transparent',
      'color:#e8ecf6', 'border-radius:999px', 'padding:4px 10px',
      'font:inherit', 'cursor:pointer',
    ].join(';');
    bar.appendChild(go);

    /* A refused token can be forgotten on its own, being certainly wrong. One
       that authenticates but may not write cannot: the answer might be to
       widen that token, or a second token might have been made while this
       browser still holds the first -- and that second case has no way out at
       all without somewhere to say "a different one". */
    var swap = document.createElement('button');
    swap.textContent = 'New token';
    swap.hidden = true;
    swap.style.cssText = go.style.cssText;
    bar.appendChild(swap);

    function note(text, bad) {
      say.textContent = text;
      say.style.color = bad ? '#ff9a2e' : '#8b96ad';
    }

    onDirty = function (changed) {
      if (go.dataset.busy) return;
      go.disabled = !changed;
      note(changed ? 'Unpublished changes' : 'No changes yet');
    };

    /* Asked for in a password field rather than a prompt, so it is not left
       sitting legibly on a screen in a cafe. */
    function askToken() {
      return new Promise(function (resolve) {
        var box = document.createElement('form');
        box.style.cssText = 'display:flex;gap:6px;align-items:center';
        var inp = document.createElement('input');
        inp.type = 'password';
        inp.placeholder = 'github token';
        inp.autocomplete = 'off';
        inp.style.cssText = [
          'border:1px solid rgba(232,236,246,.2)', 'background:rgba(0,0,0,.3)',
          'color:#e8ecf6', 'border-radius:999px', 'padding:4px 10px',
          'font:inherit', 'width:170px',
        ].join(';');
        var ok = document.createElement('button');
        ok.type = 'submit';
        ok.textContent = 'Use';
        ok.style.cssText = go.style.cssText;
        box.appendChild(inp);
        box.appendChild(ok);
        bar.replaceChild(box, go);
        inp.focus();
        box.addEventListener('submit', function (e) {
          e.preventDefault();
          var v = inp.value.trim();
          bar.replaceChild(go, box);
          resolve(v || null);
        });
      });
    }

    askForToken = function () {
      note('Paste a token with Contents write');
      return askToken();
    };

    swap.addEventListener('click', async function () {
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private window */ }
      note('Paste a token with Contents write');
      var t = await askToken();
      if (!t) { note('Cancelled \u2014 no token stored'); return; }
      try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* private window */ }
      swap.hidden = true;
      note('Token stored \u2014 press Publish');
      go.disabled = !dirty;
    });

    go.addEventListener('click', async function () {
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        note('Paste a token with Contents write');
        token = await askToken();
        if (!token) { note('Cancelled'); return; }
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* private window */ }
      }
      go.disabled = true;
      go.dataset.busy = '1';
      note('Publishing\u2026');
      try {
        await commitState(token);
        delete go.dataset.busy;
        go.disabled = true;
        swap.hidden = true;
        note('Published \u2014 live in about a minute');
      } catch (err) {
        delete go.dataset.busy;
        go.disabled = false;
        note(String(err.message || err), true);
        // a refused token is worth forgetting, or it fails the same way forever
        if (/refused|No access/.test(String(err.message))) {
          try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        } else {
          swap.hidden = false;
        }
      }
    });

    (document.body || document.documentElement).appendChild(bar);
  }

  window.claude = {
    use: async function (name) {
      var caps = await booted;
      return caps[name] || null;
    },
  };

  if (document.documentElement.hasAttribute('data-edit')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', publishUi);
    } else {
      publishUi();
    }
  }
})();
