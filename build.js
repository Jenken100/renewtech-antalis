// Builds antalis.js from src/. Run: node build.js
const fs = require('fs');
const eng = fs.readFileSync('src/engine.js', 'utf8').replace(/if \(typeof module !== 'undefined'\).*\n?/, '');
const app = fs.readFileSync('src/app.js', 'utf8');
const out = '/* Renewtech Antalis-bestilling. Kører på antalis.dk via bogmærke. Ingen data sendes andre steder hen. */\n(function () {\n"use strict";\n' + eng + '\n' + app + '\n})();\n';
new Function(out);
fs.writeFileSync('antalis.js', out);
console.log('antalis.js', out.length, 'tegn');
