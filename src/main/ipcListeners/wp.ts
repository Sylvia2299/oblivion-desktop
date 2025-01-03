// warp-plus

import toast from 'react-hot-toast';
import { app, ipcMain, BrowserWindow } from 'electron';
import treeKill from 'tree-kill';
import settings from 'electron-settings';
import log from 'electron-log';
import fs from 'fs';
import { spawn } from 'child_process';
import { isDev, removeFileIfExists, shouldProxySystem } from '../lib/utils';
import { disableProxy as disableSystemProxy, enableProxy as enableSystemProxy } from '../lib/proxy';
import { logMetadata } from './log';
import { getUserSettings, handleWpErrors } from '../lib/wp';
import { defaultSettings } from '../../defaultSettings';
import { customEvent } from '../lib/customEvent';
import { showWpLogs } from '../dxConfig';
import { getTranslate } from '../../localization';
import {
    wpAssetPath,
    wpBinPath,
    workingDirPath,
    regeditVbsDirPath,
    singBoxManager,
    netStatsManager,
    logPath
} from '../../constants';

const simpleLog = log.create({ logId: 'simpleLog' });
simpleLog.transports.console.format = '{text}';
simpleLog.transports.file.format = '{text}';

let child: any;
let exitOnWpEnd = false;
let appLang = getTranslate('en');
let connectedFlags: boolean[];
let disconnectedFlags: boolean[];
let shouldStartSingBox: boolean = true;
let shouldStopSingBox: boolean = true;

export const restartApp = () => {
    const maxRetries = 2;
    let retryCount = 0;
    const attemptRestart = () => {
        try {
            const allWindows = BrowserWindow.getAllWindows();
            if (allWindows.length > 0) {
                allWindows.forEach((win) => {
                    if (!win.isDestroyed()) {
                        win.close();
                    }
                });
            }
            log.info('The app is being relaunched due to encountering a warp-plus error.');
            app.relaunch();
            app.quit();
        } catch (error) {
            retryCount += 1;
            log.error(`Error during app restart (attempt ${retryCount}):`, error);
            if (retryCount < maxRetries) {
                log.info('Retrying app quit...');
                setTimeout(attemptRestart, 1500);
            } else {
                log.error('Max retry limit reached. Could not restart app.');
            }
        }
    };
    setTimeout(attemptRestart, 5000);
};

ipcMain.on('wp-start', async (event, arg) => {
    if (arg && arg === 'start-from-gool') {
        shouldStartSingBox = false;
    } else {
        shouldStartSingBox = true;
    }
    const port = (await settings.get('port')) || defaultSettings.port;
    const hostIP = (await settings.get('hostIP')) || defaultSettings.hostIP;
    //const autoSetProxy = await settings.get('autoSetProxy');
    const proxyMode = await settings.get('proxyMode');
    const lang = await settings.get('lang');
    const ipData = (await settings.get('ipData')) || defaultSettings.ipData;
    const dataUsage = (await settings.get('dataUsage')) || defaultSettings.dataUsage;
    const restartCounter =
        ((await settings.get('restartCounter')) as number) || defaultSettings.restartCounter;
    appLang = getTranslate(String(typeof lang !== 'undefined' ? lang : defaultSettings.lang));

    /*if (! net.isOnline()) {
        event.reply('guide-toast', appLang.toast.offline);
        event.reply('wp-end', true);
        return;
    }*/

    if (!fs.existsSync(wpBinPath)) {
        event.reply('guide-toast', appLang.log.error_wp_not_found);
        event.reply('wp-end', true);
        if (fs.existsSync(wpAssetPath) && restartCounter < 2) {
            await settings.set('restartCounter', restartCounter + 1);
            restartApp();
        }
        return;
    }

    exitOnWpEnd = false;
    connectedFlags = [false, false];
    disconnectedFlags = [false, false];

    const sendConnectedSignalToRenderer = () => {
        customEvent.emit('tray-icon', 'connecting');
        if (connectedFlags[0] && connectedFlags[1]) {
            event.reply('wp-start', true);
            customEvent.emit(
                'tray-icon',
                `connected-${typeof proxyMode !== 'undefined' ? proxyMode : defaultSettings.proxyMode}`
            );
            toast.remove('GUIDE');
            if (ipData && dataUsage && proxyMode !== 'none') {
                netStatsManager.startMonitoring(event);
            }
        }
    };

    const sendDisconnectedSignalToRenderer = () => {
        customEvent.emit('tray-icon', 'disconnecting');
        if (disconnectedFlags[0] && disconnectedFlags[1]) {
            netStatsManager.stopMonitoring();
            event.reply('wp-end', true);

            // send signal to `exitTheApp` function
            if (exitOnWpEnd) ipcMain.emit('exit');
            customEvent.emit('tray-icon', 'disconnected');
        }
    };

    await removeFileIfExists(logPath);
    log.info('past logs was deleted for new connection.');
    logMetadata();

    const args = await getUserSettings();

    /*const license = await settings.get('license');
    if (typeof license === 'string' && license !== '') {
        setStuffPath(args);
    }*/

    const handleSystemProxyDisconnect = async () => {
        if (shouldProxySystem(proxyMode)) {
            disableSystemProxy(regeditVbsDirPath, event).then(() => {
                disconnectedFlags[0] = true;
                sendDisconnectedSignalToRenderer();
            });
        } else {
            disconnectedFlags[0] = true;
            sendDisconnectedSignalToRenderer();
        }
    };

    if (shouldProxySystem(proxyMode)) {
        enableSystemProxy(regeditVbsDirPath, event)
            .then(() => {
                connectedFlags[0] = true;
                sendConnectedSignalToRenderer();
            })
            .catch(() => {
                handleSystemProxyDisconnect();
            });
    } else {
        connectedFlags[0] = true;
        sendConnectedSignalToRenderer();
    }

    const startWP = () => {
        log.info('starting wp process...');
        log.info(`${wpBinPath + ' ' + args.join(' ')}`);

        try {
            child = spawn(wpBinPath, args, { cwd: workingDirPath });
            const successMessage = `level=INFO msg="serving proxy" address=${hostIP}`;
            //const endpointMessage = `level=INFO msg="using warp endpoints" endpoints=`;
            //let endpointPorts: number[] = [];
            // const successTunMessage = `level=INFO msg="serving tun"`;

            child.stdout.on('data', async (data: any) => {
                const strData = data.toString();

                /* if (strData.includes(endpointMessage) && proxyMode === 'tun') {
                    endpointPorts = extractPortsFromEndpoints(strData);
                } */

                if (strData.includes(successMessage)) {
                    if (proxyMode === 'tun' && !(await singBoxManager.checkConnectionStatus())) {
                        event.reply('wp-end', true);
                        if (typeof child?.pid !== 'undefined') {
                            treeKill(child.pid, 'SIGKILL');
                        }
                    } else {
                        connectedFlags[1] = true;
                        sendConnectedSignalToRenderer();
                        await settings.set('restartCounter', 0);
                    }
                }

                // Save the last endpoint that was successfully connected
                const endpointRegex =
                    /msg="(?:scan results|using warp endpoints)" endpoints="\[.*?(?:AddrPort:)?(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})/;
                const match = strData.match(endpointRegex);
                if (match) {
                    await settings.set('scanResult', match[1]);
                }

                handleWpErrors(strData, event, String(port));

                if (!showWpLogs && isDev()) return;
                simpleLog.info(strData);
            });

            child.stderr.on('data', (err: any) => {
                if (!showWpLogs && isDev()) return;
                simpleLog.error(`err: ${err.toString()}`);
            });

            child.on('exit', async () => {
                if (
                    proxyMode === 'tun' &&
                    shouldStopSingBox &&
                    !(await singBoxManager.stopSingBox())
                ) {
                    event.reply('wp-end', false);
                } else {
                    disconnectedFlags[1] = true;
                    sendDisconnectedSignalToRenderer();
                    log.info('wp process exited.');
                    child.pid = undefined;
                    await handleSystemProxyDisconnect();
                }
            });
        } catch (error) {
            event.reply('guide-toast', appLang.log.error_wp_stopped);
            event.reply('wp-end', true);
            // If the warp-plus file is damaged for any reason, it will be deleted so that when the program is closed and reopened, a new file is created in the previous path.
            // This prevents the user from needing to reinstall the program if they encounter the mentioned error.
            if (fs.existsSync(wpBinPath)) {
                fs.rm(wpBinPath, (err) => {
                    if (err) throw err;
                    log.info('wp binary was deleted from userData directory.');
                    restartApp();
                });
            }
        }
    };

    if (
        proxyMode === 'tun' &&
        shouldStartSingBox &&
        !(await singBoxManager.startSingBox(appLang, event))
    ) {
        event.reply('wp-end', true);
        if (typeof child?.pid !== 'undefined') {
            treeKill(child.pid, 'SIGKILL');
        }
    } else {
        startWP();
    }
});

ipcMain.on('wp-end', async (event, arg) => {
    if (arg && arg === 'stop-from-gool') {
        shouldStopSingBox = false;
    } else {
        shouldStopSingBox = true;
    }
    try {
        if (typeof child?.pid !== 'undefined') {
            treeKill(child.pid, 'SIGKILL');
        }
    } catch (error) {
        log.error(error);
        event.reply('wp-end', false);
    }
});

ipcMain.on('end-wp-and-exit-app', async (event) => {
    const closeHelperSetting = await settings.get('closeHelper');
    const closeHelper =
        typeof closeHelperSetting === 'boolean' ? closeHelperSetting : defaultSettings.closeHelper;
    try {
        if (typeof child?.pid !== 'undefined') {
            treeKill(child.pid, 'SIGKILL');
            exitOnWpEnd = true;
        } else {
            // send signal to `exitTheApp` function
            ipcMain.emit('exit');
        }
        if (closeHelper) {
            await singBoxManager.stopHelper();
        }
    } catch (error) {
        log.error(error);
        event.reply('wp-end', false);
    }
});
