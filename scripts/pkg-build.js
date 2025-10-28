const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const platform = os.platform(); // 'win32', 'linux', 'darwin'

const platformMap = {
    win32: 'win',
    linux: 'linux',
    darwin: 'macos'
};

const targetPlatform = platformMap[platform] || 'linux';

const nodeVersion = process.versions.node.split('.')[0];

const target = `node${nodeVersion}-${targetPlatform}-x64`;

const outputPath = path.resolve(__dirname, '..', 'dist', 'deploy');

console.log(`Building for target: ${target}`);

try {
    execSync(`pkg server.js --targets ${target} --output ${outputPath}`, { stdio: 'inherit' });
    console.log('Build successful!');
} catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
}
