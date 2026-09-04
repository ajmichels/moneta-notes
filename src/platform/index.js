import * as darwin from './darwin.js';
import * as linux from './linux.js';

const IMPLS = { darwin, linux };

export function resolveImpl(platform = process.platform) {
    const impl = IMPLS[platform];
    if (!impl) {
        throw new Error(`Unsupported platform: ${platform}`);
    }
    return impl;
}

const impl = resolveImpl();

export const appSupportDir = impl.appSupportDir;
export const logDir = impl.logDir;
export const daemonServiceName = impl.daemonServiceName;
export const startDaemonService = impl.startDaemonService;
export const stopDaemonService = impl.stopDaemonService;
export const restartDaemonService = impl.restartDaemonService;
