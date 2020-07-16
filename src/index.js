const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const log4js = require('log4js');
const { KeepLiveWS, KeepLiveTCP } = require('bilibili-live-ws');
const { Danmaku, BaseDanmakuWebSocketSource } = require('@danmaqua/danmaku-src-common');
const { delay } = require('./util');

const BATCH_RECONNECT_DELAY = 1000 * 10;

let src = null;

class BilibiliDanmakuSource extends BaseDanmakuWebSocketSource {
    constructor({hostname, port, basicAuth, bilibiliProtocol, reconnectCron, logger}) {
        super({hostname, port, basicAuth});
        this.liveList = {};
        this.logger = logger;
        if (bilibiliProtocol !== 'ws' && bilibiliProtocol !== 'tcp') {
            this.logger.info('Bilibili Danmaku Source configuration didn\'t' + 
                ' specify protocol type. Set to ws as default.');
            bilibiliProtocol = 'ws';
        }
        this.bilibiliProtocol = bilibiliProtocol;
        if (reconnectCron) {
            this.logger.info(`Reconnect task schedule at "${reconnectCron}"`);
            cron.schedule(reconnectCron, () => this.batchReconnect());
        }
    }

    isConnected(roomId) {
        const entity = this.liveList[roomId];
        return entity && entity.live;
    }

    createLive(roomId) {
        const live = this.bilibiliProtocol === 'ws' ? new KeepLiveWS(roomId) : new KeepLiveTCP(roomId);
        live.on('live', () => {
            this.logger.debug(`Connected to live room: ${roomId}`);
        });
        live.on('DANMU_MSG', (data) => {
            const dmInfo = data['info'];
            const dmSenderInfo = dmInfo[2];
            const dmSenderUid = dmSenderInfo[0];
            const dmSenderUsername = dmSenderInfo[1];
            const dmSenderUrl = 'https://space.bilibili.com/' + dmSenderUid;
            const dmText = dmInfo[1];
            const dmTimestamp = dmInfo[9]['ts'];

            const danmaku = new Danmaku({
                sender: {
                    uid: dmSenderUid,
                    username: dmSenderUsername,
                    url: dmSenderUrl
                },
                text: dmText,
                timestamp: dmTimestamp,
                roomId: roomId
            });
            this.sendDanmaku(danmaku);
        });
        live.on('error', (e) => {
            this.logger.error(`BilibiliDanmakuSource roomId=${roomId} error:`, e);
        });
        return live;
    }

    onJoin(roomId) {
        super.onJoin(roomId);
        if (this.isConnected(roomId)) {
            this.liveList[roomId].counter++;
            return;
        }
        try {
            this.liveList[roomId] = {
                live: this.createLive(roomId),
                counter: 1
            };
        } catch (e) {
            this.logger.error(e);
        }
    }

    onLeave(roomId) {
        super.onLeave(roomId);
        if (!this.isConnected(roomId)) {
            return;
        }
        try {
            const entity = this.liveList[roomId];
            entity.counter--;
            if (entity.counter <= 0) {
                this.logger.debug(`Room ${roomId} is no longer used. Close now.`);
                entity.live.close();
                delete this.liveList[roomId];
            }
        } catch (e) {
            this.logger.error(e);
        }
    }

    onReconnect(roomId) {
        super.onReconnect(roomId);
        if (!this.isConnected(roomId)) {
            return;
        }
        try {
            const entity = this.liveList[roomId];
            entity.live.close();
            entity.live = this.createLive(roomId);
        } catch (e) {
            this.logger.error(e);
        }
    }

    batchReconnect = async () => {
        this.logger.debug('Start batch reconnect task');
        for (let roomId of Object.keys(this.liveList)) {
            this.onReconnect(Number(roomId));
            await delay(BATCH_RECONNECT_DELAY);
        }
    }
}

function startServer() {
    const configJson = fs.readFileSync('./config.json');
    const config = JSON.parse(configJson.toString('utf-8'));
    log4js.configure({
        appenders: {
            stdout: { type: 'stdout' },
            outfile: {
                type: 'dateFile',
                filename: path.join(config.logsDir, 'log'),
                pattern: 'yyyy-MM-dd.log',
                alwaysIncludePattern: true,
                keepFileExt: false
            }
        },
        categories: {
            default: {
                appenders: ['stdout', 'outfile'],
                level: 'debug'
            }
        }
    });
    src = new BilibiliDanmakuSource({
        hostname: config.hostname,
        port: config.port,
        basicAuth: config.basicAuth,
        bilibiliProtocol: config.bilibiliProtocol,
        reconnectCron: config.reconnectCron,
        logger: log4js.getLogger('default')
    });
    src.on('listen', () => {
        src.logger.info(`Bilibili Danmaku Source Server is listening at ${src.hostname}:${src.port}`);
    });
    src.listen();
}

startServer();
