// main.js — ES module entry point; wires the site modules.

import { createFooter } from './modules/footer.js';
import { createInstallCopy } from './modules/installCopy.js';
import { createNav } from './modules/nav.js';

const modules = [createFooter(), createInstallCopy(), createNav()];

document.addEventListener('DOMContentLoaded', () => modules.forEach((m) => m.init()));
