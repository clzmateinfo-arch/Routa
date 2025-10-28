const fs = require('fs-extra');
const path = require('path');

const filesToCopy = [
    'package.json',
    'package-lock.json',
    '.env.production'
];

const srcDir = path.resolve(__dirname, '..');
const distDir = path.resolve(__dirname, '..', 'dist/prod');

fs.removeSync(distDir);
fs.mkdirSync(distDir);

filesToCopy.forEach(file => {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(distDir, file);

    if (fs.existsSync(srcPath)) {
        fs.copySync(srcPath, destPath);
        console.log(`✅ Copied: ${file}`);
    } else {
        console.warn(`⚠️  File not found: ${file}`);
    }
});

const srcCodeDir = path.join(srcDir, 'src');
if (fs.existsSync(srcCodeDir)) {
    fs.copySync(srcCodeDir, path.join(distDir, 'src'));
    console.log(`✅ Copied: /src`);
} else {
    console.error(`❌ Source folder "/src" not found.`);
}

console.log('🎉 Build complete! Deployment artifacts are in /dist/prod');
