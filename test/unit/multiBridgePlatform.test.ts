/**
 * The platform in multi-bridge mode: publishes its own HAP bridges
 * (HAP publish faked), registers no platform accessories, unpublishes on
 * Homebridge shutdown.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { API, HAP, PlatformAccessory } from 'homebridge';
import { HomematicPlatform } from '../../src/platform.js';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { persistFileName } from '../../src/multiBridge/identityStore.js';
import { PLUGIN_VERSION } from '../../src/settings.js';
import { makeLog } from '../helpers/hapStub.js';

const hap = (await import(process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs')) as unknown as HAP;

const USER = 'CC:22:3D:E3:CE:0A';
const LAMP = '0000CCCCCCCCCC:2';

class FakeApi extends EventEmitter {
  hap = hap;
  constructor(private readonly persist: string) {
    super();
  }
  user = { storagePath: () => this.persist, persistPath: () => this.persist };
  registerPlatformAccessories = vi.fn();
  unregisterPlatformAccessories = vi.fn();
  updatePlatformAccessories = vi.fn();
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HomematicPlatform in multi-bridge mode', () => {
  it('keeps PLUGIN_VERSION equal to package.json', () => {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it('publishes enabled bridges itself and registers no platform accessory', async () => {
    const persist = await fs.mkdtemp(path.join(os.tmpdir(), 'hmhap-multiplatform-'));
    try {
      await fs.writeFile(path.join(persist, persistFileName('AccessoryInfo', USER)),
        JSON.stringify({ signSk: 'x', pincode: '111-22-333' }), { mode: 0o600 });
      await fs.writeFile(path.join(persist, persistFileName('IdentifierCache', USER)), JSON.stringify({ cache: {} }), { mode: 0o600 });

      vi.spyOn(CcuClient.prototype, 'start').mockResolvedValue();
      vi.spyOn(CcuClient.prototype, 'stop').mockResolvedValue();
      vi.spyOn(CcuClient.prototype, 'isLive').mockReturnValue(true);
      vi.spyOn(CcuClient.prototype, 'listDevices').mockResolvedValue([
        { address: '0000CCCCCCCCCC', type: 'HmIPW-DRS8', name: 'lamp', interface: 'HmIP-RF',
          channels: [{ address: LAMP, index: 2, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Lamp ch' }] },
      ]);
      vi.spyOn(CcuClient.prototype, 'getValue').mockRejectedValue(new Error('offline'));
      const publish = vi.spyOn(hap.Accessory.prototype, 'publish').mockResolvedValue(undefined as never);
      const unpublish = vi.spyOn(hap.Accessory.prototype, 'unpublish').mockResolvedValue(undefined as never);
      const destroy = vi.spyOn(hap.Accessory.prototype, 'destroy');

      const api = new FakeApi(persist);
      const log = makeLog();
      const platform = new HomematicPlatform(log, {
        platform: 'HomematicHap',
        name: 'HomeMatic Bridges',
        ccuIp: '127.0.0.1',
        eventServer: { port: 51875 },
        multiBridge: {
          bridges: [
            { name: 'HomeMatic Flur', enabled: true, username: USER, pincode: '111-22-333', port: 51001,
              channels: [{ address: LAMP, service: 'SwitchAccessory', name: 'Flur Licht', uuidSeed: 'SWITCH_VIRTUAL_RECEIVER:Flur Licht' }] },
            { name: 'HomeMatic Live', username: 'CC:22:3D:E3:CE:0B', pincode: '111-22-334', port: 51002,
              channels: [{ address: LAMP, service: 'SwitchAccessory' }] },
          ],
        },
      }, api as unknown as API);
      platform.configureAccessory({ UUID: 'old', displayName: 'Old', context: {} } as unknown as PlatformAccessory);

      api.emit('didFinishLaunching');
      await flush();
      expect(publish).toHaveBeenCalledTimes(1);
      const [info, insecure] = publish.mock.calls[0]!;
      expect(info).toMatchObject({ username: USER, port: 51001, advertiser: 'ciao', addIdentifyingMaterial: false });
      expect(insecure).toBe(false);
      expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
      expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();

      api.emit('shutdown');
      await flush();
      expect(unpublish).toHaveBeenCalledTimes(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(CcuClient.prototype.stop).toHaveBeenCalled();
    } finally {
      await fs.rm(persist, { recursive: true, force: true });
    }
  });

  it('stays idle on an invalid multiBridge section', () => {
    const log = makeLog();
    const platform = new HomematicPlatform(log, {
      platform: 'HomematicHap', ccuIp: '127.0.0.1', multiBridge: { bridges: [] },
    }, new FakeApi('/nonexistent') as unknown as API);
    expect(platform.getCcu()).toBeUndefined();
    expect(vi.mocked(log.error)).toHaveBeenCalled();
  });
});
