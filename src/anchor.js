import { Storage } from './storage.js';

export class Anchor {
    static async init() {}

    static async getCoreTraits(role) {
        return await Storage.getCoreTraits(role);
    }

    static async setCoreTraits(role, traits) {
        await Storage.setCoreTraits(role, traits);
    }

    static async getPendingCorrection(role) {
        const correction = await Storage.getPendingCorrection(role);
        if (correction) {
            await Storage.clearPendingCorrection(role);
        }
        return correction;
    }
}
