// installCopy.js — copy-to-clipboard for the install code blocks.
// Module pattern: event delegation on the install section.

export function createInstallCopy() {
  const RESTORE_MS = 1500;

  function legacyCopy(text) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      console.warn('installCopy: legacy copy failed', err);
    }
    helper.remove();
    return ok;
  }

  function markCopied(button) {
    if (!button.dataset.label) {
      button.dataset.label = button.textContent;
    }
    button.textContent = 'copied';
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = button.dataset.label;
      button.disabled = false;
    }, RESTORE_MS);
  }

  return {
    init() {
      const section = document.getElementById('install');
      if (!section) return;

      section.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy]');
        if (!button || button.disabled) return;

        const text = button.dataset.copy;
        let ok = false;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          try {
            await navigator.clipboard.writeText(text);
            ok = true;
          } catch (err) {
            console.warn('installCopy: clipboard write failed', err);
            ok = legacyCopy(text);
          }
        } else {
          ok = legacyCopy(text);
        }

        if (ok) {
          markCopied(button);
        } else {
          console.warn('installCopy: copy unavailable — select the code and copy manually');
        }
      });
    },
  };
}
