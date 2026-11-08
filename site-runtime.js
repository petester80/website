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
  window.__resolveAsset = function (id) {
    return IMAGES_DIR + '/' + encodeURIComponent(id);
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
        // a visitor's changes live as long as their tab does, and no longer
        set: async function () {},
      };
    },
  };

  var booted = (async function () {
    try {
      var r = await fetch('./' + STATE_FILE, { cache: 'no-store' });
      if (r.ok) docs = (await r.json()) || {};
    } catch (e) {
      /* No state file, or a server that would not give it up. The page has a
         sample river of its own for exactly this, so let it show that rather
         than nothing at all. */
    }
    return { db: db };
  })();

  window.claude = {
    use: async function (name) {
      var caps = await booted;
      return caps[name] || null;
    },
  };
})();
