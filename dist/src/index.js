import { HomematicPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';
export default (api) => {
    api.registerPlatform(PLATFORM_NAME, HomematicPlatform);
};
//# sourceMappingURL=index.js.map