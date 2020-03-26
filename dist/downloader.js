'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = require("fs-extra");
const path_1 = require("path");
const events_1 = require("events");
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36';
const request = require('request');
const requestProgress = require('request-progress');
var DOWNLOADER_STATE;
(function (DOWNLOADER_STATE) {
    DOWNLOADER_STATE[DOWNLOADER_STATE["IDLE"] = 0] = "IDLE";
    DOWNLOADER_STATE[DOWNLOADER_STATE["DOWNLOAD"] = 1] = "DOWNLOAD";
    DOWNLOADER_STATE[DOWNLOADER_STATE["FAILURE"] = 2] = "FAILURE";
    DOWNLOADER_STATE[DOWNLOADER_STATE["SUCCESS"] = 3] = "SUCCESS";
})(DOWNLOADER_STATE = exports.DOWNLOADER_STATE || (exports.DOWNLOADER_STATE = {}));
class Downloader extends events_1.EventEmitter {
    constructor(url, file) {
        super();
        this.state = DOWNLOADER_STATE.IDLE;
        this.percent = 0;
        this.size = {
            total: 0,
            transferred: 0,
        };
        this.url = url;
        this.file = file;
    }
}
exports.Downloader = Downloader;
var MANAGER_STATE;
(function (MANAGER_STATE) {
    // 关闭状态，在这个状态下不会开始下载
    MANAGER_STATE[MANAGER_STATE["CLOSE"] = 0] = "CLOSE";
    // 闲置状态，已经启动，允许下载，但是没有下载任务
    MANAGER_STATE[MANAGER_STATE["IDLE"] = 1] = "IDLE";
    // 已经启动，并且正在下载
    MANAGER_STATE[MANAGER_STATE["BUSY"] = 2] = "BUSY";
})(MANAGER_STATE = exports.MANAGER_STATE || (exports.MANAGER_STATE = {}));
class DownloadManager {
    constructor() {
        this.state = MANAGER_STATE.CLOSE;
        this.queue = [];
        this.current = null;
    }
    /**
     * 开始下载
     */
    start() {
        this.state = MANAGER_STATE.IDLE;
        this._handle();
    }
    /**
     * 停止下载
     */
    stop() {
        this.state = MANAGER_STATE.CLOSE;
        if (!this.current) {
            return;
        }
        this.current.request && this.current.request.abort();
        this.queue.splice(0, 0, this.current);
        this.current = null;
    }
    /**
     * 中断一个下载对象
     * @param item
     */
    abort(item) {
        if (item === this.current) {
            this.current.request && this.current.request.abort();
            this.queue.splice(0, 0, this.current);
            this.current = null;
            this._handle();
        }
        else {
            const index = this.queue.indexOf(item);
            if (index !== -1) {
                this.queue.splice(index, 1);
            }
        }
    }
    /**
     * 下载一个文件
     * @param url
     * @param file
     */
    download(url, file) {
        const downloader = new Downloader(url, file);
        this.queue.push(downloader);
        this._handle();
        return downloader;
    }
    /**
     * 执行下一步
     */
    _handle() {
        if (this.state === MANAGER_STATE.CLOSE
            || this.state === MANAGER_STATE.BUSY) {
            return;
        }
        const downloader = this.queue.shift();
        if (!downloader) {
            return;
        }
        this.state = MANAGER_STATE.BUSY;
        this.current = downloader;
        // 生成存放文件的文件夹
        fs_extra_1.ensureDirSync(path_1.dirname(downloader.file));
        downloader.emit('start');
        downloader.state = DOWNLOADER_STATE.DOWNLOAD;
        downloader.request = request.get({
            url: downloader.url,
            // timeout: 10000,
            headers: {
                'User-Agent': USER_AGENT,
            }
        })
            .on('response', (response) => {
            response.pipe(fs_extra_1.createWriteStream(downloader.file));
            if (response.statusCode === 200) {
                response.pipe(fs_extra_1.createWriteStream(downloader.file)
                    .on('close', () => {
                    this.state = MANAGER_STATE.IDLE;
                    downloader.state = DOWNLOADER_STATE.SUCCESS;
                    downloader.emit('finish');
                    downloader.request = null;
                    this.current = null;
                    this._handle();
                })
                    .on('error', (e) => {
                    downloader.emit('abort', `Something went wrong while writing to the file of ${downloader.url} ${e} ${e.stack}`);
                }));
            }
            else if (response.statusCode === 204) {
                downloader.state = DOWNLOADER_STATE.FAILURE;
                downloader.emit('abort', `Download file was empty (${downloader.url})`);
            }
            else {
                downloader.state = DOWNLOADER_STATE.FAILURE;
                downloader.emit('abort', `Download file could not be found and returned code: ${response.statusCode} (${downloader.url})`);
            }
        })
            .on('abort', () => {
            downloader.state = DOWNLOADER_STATE.FAILURE;
            downloader.emit('abort', 'The downloader was cancelled');
            downloader.request = null;
            this.current = null;
            this._handle();
        })
            .on('error', (error) => {
            downloader.state = DOWNLOADER_STATE.FAILURE;
            downloader.emit('abort', `Something went wrong while downloading ${downloader.url} ${error} ${error.stack}`);
            downloader.request = null;
            this.current = null;
            this._handle();
        });
        requestProgress(downloader.request, {
            throttle: 1000,
        })
            .on('progress', (item) => {
            downloader.size.total = item.size.total;
            downloader.size.transferred = item.size.transferred;
            downloader.percent = item.percent;
            downloader.emit('change');
        });
    }
}
exports.DownloadManager = DownloadManager;
