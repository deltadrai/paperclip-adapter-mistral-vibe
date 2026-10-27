// main.js — ES module entry point; wires the site modules.

import { createFooter } from './modules/footer.js';
import { createInstallCopy } from './modules/installCopy.js';
import { createNav } from './modules/nav.js';
import { createHeroPixels } from './modules/heroPixels.js';

const modules = [createFooter(), createInstallCopy(), createNav(), createHeroPixels()];

document.addEventListener('DOMContentLoaded', () => modules.forEach((m) => m.init()));
