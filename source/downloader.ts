'use strict';

import { createWriteStream, ensureDirSync } from 'fs-extra';
import { dirname } from 'path';
import { EventEmitter } from 'events';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36';

const request = require('request');
const requestProgress = require('request-progress');

export enum DOWNLOADER_STATE {
    IDLE,
    DOWNLOAD,
    FAILURE,
    SUCCESS,
}

export class Downloader extends EventEmitter {

    state: DOWNLOADER_STATE = DOWNLOADER_STATE.IDLE;

    url: string;
    file: string;

    percent: number = 0;

    request: any;

    size = {
        total: 0,
        transferred: 0,
    };

    constructor(url: string, file: string) {
        super();
        this.url = url;
        this.file = file;
    }
}

export enum MANAGER_STATE {
    // 关闭状态，在这个状态下不会开始下载
    CLOSE,
    // 闲置状态，已经启动，允许下载，但是没有下载任务
    IDLE,
    // 已经启动，并且正在下载
    BUSY,
}

export class DownloadManager {
    state: MANAGER_STATE = MANAGER_STATE.CLOSE;

    queue: Downloader[] = [];
    current: Downloader | null = null;

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
    abort(item: Downloader) {
        if (item === this.current) {
            this.current.request && this.current.request.abort();
            this.queue.splice(0, 0, this.current);
            this.current = null;
            this._handle();
        } else {
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
    download(url: string, file: string) {
        const downloader = new Downloader(url, file);
        this.queue.push(downloader);
        this._handle();
        return downloader;
    }

    /**
     * 执行下一步
     */
    private _handle() {
        if (
            this.state === MANAGER_STATE.CLOSE
            || this.state === MANAGER_STATE.BUSY
        ) {
            return;
        }

        const downloader = this.queue.shift();
        if (!downloader) {
            return;
        }

        this.state = MANAGER_STATE.BUSY;
        this.current = downloader;

        // 生成存放文件的文件夹
        ensureDirSync(dirname(downloader.file));

        downloader.emit('start');
        downloader.state = DOWNLOADER_STATE.DOWNLOAD;
        downloader.request = request.get({
            url: downloader.url,
            // timeout: 10000,
            headers: {
                'User-Agent': USER_AGENT,
            }
        })
        .on('response', (response: any) => {
            response.pipe(createWriteStream(downloader.file))
            if (response.statusCode === 200) {
                response.pipe(
                  createWriteStream(downloader.file)
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
                        })
                );
            } else if (response.statusCode === 204) {
                downloader.state = DOWNLOADER_STATE.FAILURE;
                downloader.emit('abort', `Download file was empty (${downloader.url})`);
            } else {
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
        .on('error', (error: any) => {
            downloader.state = DOWNLOADER_STATE.FAILURE;
            downloader.emit('abort', `Something went wrong while downloading ${downloader.url} ${error} ${error.stack}`);

            downloader.request = null;
            this.current = null;
            this._handle();
        });

        requestProgress(downloader.request, {
            throttle: 1000,
        })
        .on('progress', (item: { percent: number, speed: number, size: { total: number, transferred: number }, time: { elapsed: number, remaining: number } }) => {
            downloader.size.total = item.size.total;
            downloader.size.transferred = item.size.transferred;
            downloader.percent = item.percent;
            downloader.emit('change');
        });
    }
}