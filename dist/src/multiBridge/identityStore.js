/**
 * Read-only checks on the transplanted HAP identity files of a bridge
 * (`AccessoryInfo.<ID>.json` with the pairing keys, `IdentifierCache.<ID>.json`
 * with the accessory and instance ids) in Homebridge's persist directory,
 * which is also HAP-NodeJS's storage directory in a child bridge process.
 *
 * Without them HAP-NodeJS would silently create a *new* identity under the
 * old username: a second, unpaired bridge advertising the id of the real
 * one, and fresh instance ids that HomeKit treats as new accessories.
 *
 * Nothing here returns or logs key material, pins or setup ids; only
 * whether they match the configuration.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
export function persistFileName(kind, username) {
    return `${kind}.${username.replace(/:/g, '').toUpperCase()}.json`;
}
function readJson(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        return { state: err.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { state: 'unreadable' };
        }
        return { state: 'ok', value: value };
    }
    catch {
        return { state: 'unreadable' };
    }
}
export function persistIdentityStore(persistDir) {
    return {
        check(entry) {
            const info = readJson(path.join(persistDir, persistFileName('AccessoryInfo', entry.username)));
            const cache = readJson(path.join(persistDir, persistFileName('IdentifierCache', entry.username)));
            const cacheOk = cache.state === 'ok' && typeof cache.value?.cache === 'object' && cache.value.cache !== null;
            const infoOk = info.state === 'ok' && typeof info.value?.signSk === 'string';
            const result = {
                accessoryInfo: info.state === 'ok' && !infoOk ? 'unreadable' : info.state,
                identifierCache: cache.state === 'ok' && !cacheOk ? 'unreadable' : cache.state,
            };
            if (infoOk) {
                result.pincodeMatches = info.value.pincode === entry.pincode;
                if (entry.setupID !== undefined) {
                    result.setupIdMatches = info.value.setupID === entry.setupID;
                }
            }
            return result;
        },
    };
}
/** Human-readable reason why an identity must not be published, or undefined. */
export function identityProblem(check) {
    if (check.accessoryInfo !== 'ok') {
        return `AccessoryInfo file ${check.accessoryInfo}`;
    }
    if (check.identifierCache !== 'ok') {
        return `IdentifierCache file ${check.identifierCache}`;
    }
    if (check.pincodeMatches === false) {
        return 'pincode differs from the persisted AccessoryInfo';
    }
    if (check.setupIdMatches === false) {
        return 'setupID differs from the persisted AccessoryInfo';
    }
    return undefined;
}
//# sourceMappingURL=identityStore.js.map