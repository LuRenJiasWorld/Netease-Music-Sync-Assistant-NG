const fs = require('fs');
const path = require('path');
const fsPromised = require('fs').promises;
const ini = require('ini');
const axios = require('axios');
const log = require('loglevel');
const prefix = require('loglevel-plugin-prefix');
const chalk = require('chalk');
const ffmetadata = require('ffmetadata');
const flacmetadata = require("flac-metadata2");
const filenamify = require('filenamify');
const Downloader = require('nodejs-file-downloader');
const urlParameterAppend = require('url-parameter-append');
const fileType = require('file-type');
const { cloneDeep } = require('lodash');
const { sleep } = require('sleepjs');

// 初始化配置
const config = ini.parse(fs.readFileSync('./config/config.ini', 'utf-8'));


// 日志配置
const logColors = {
    TRACE: chalk.magenta,
    DEBUG: chalk.cyan,
    INFO: chalk.blue,
    WARN: chalk.yellow,
    ERROR: chalk.red,
};

prefix.reg(log);

prefix.apply(log, {
    format(level, name, timestamp) {
      return `${chalk.gray(`[${timestamp}]`)} ${logColors[level.toUpperCase()](level)}`;
    },
});
    
log.setLevel(config.runtime.log_level)

// 初始化Axios
let request = axios.create({
    baseURL: config.api.api_endpoint,
    timeout: 3000,
    withCredentials: true,
});

const welcome = async () => {
    const metaData = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
    log.info(`😉 欢迎使用${metaData.name} v${metaData.version} ！`);
    log.info(`🙆‍ 作者：${metaData.author}，光荣地以${metaData.license}释出源码，祝您使用愉快！`);
    log.info(`📃 请阅读根目录下的README.md获取使用详情，或在 https://example.placeholder/ 求助。`);
    log.info('');
}

const login = async () => {
    if (config.generic.save_cookie === true) {
        log.debug('尝试从本地加载Cookie');
        if (!fs.existsSync('./data/cookie.txt')) {
            log.warn('Cookie数据文件不存在，重建中...');
            fs.writeFileSync('./data/cookie.txt', '');
        }
        const localCookie = fs.readFileSync('./data/cookie.txt', 'utf-8');

        if (localCookie !== "") {
            log.debug('Cookie从本地获取成功: ' + localCookie);
            return localCookie
        };
    }
    try {
        log.debug('登录后从服务器获取Cookie');
        const response = await request.get(
            `${config.api.api_endpoint}/login/cellphone?phone=${config.account.phone}&md5_password=${config.account.md5_password}`
        );
        
        log.debug('登录结果: ' + JSON.stringify(response.data));
        log.debug('Cookie从服务器获取成功: ' + response.data['cookie']);
        return response.data['cookie'];
    } catch (e) {
        log.error('登录时出现错误: ' + e);
    }
};

const saveCookie = async (cookie) => {    
    if (config.generic.save_cookie === true) {
        log.debug('将Cookie保存到本地');
        fs.writeFileSync("./data/cookie.txt", cookie.toString());
    }
};

const getUserInfo = async () => {
    // log.info(`当前登录用户为${userInfo.nickname}`);
};

const fetchPlaylist = async () => {
    const response = await request.get(`/playlist/detail?id=${config.account.playlist_id}`);
    return response.data.playlist.trackIds;
}

const diffPlaylist = async (playlist) => {
    if (!fs.existsSync('./data/playlist.json')) {
        log.warn('播放列表数据文件不存在，重建中...');
        fs.writeFileSync('./data/playlist.json', '[]');
    }
    const localPlaylist = JSON.parse(fs.readFileSync('./data/playlist.json', 'utf-8'));
    const newIds = [];

    playlist.forEach((eachMusic) => {
        if (!localPlaylist.includes(eachMusic.id)) {
            newIds.push(eachMusic.id);
        }
    });

    return newIds;
};

// ID3信息集成
// 顺便把回调函数改成Promise
const id3Embed = ({ musicPath, coverPath, musicMeta }) => {
    switch (musicPath.split('.').pop()) {
        case "mp3":
            return new Promise((resolve, reject) => {
                ffmetadata.write(
                    musicPath,
                    musicMeta,
                    {
                        attachments: [coverPath],
                        "id3v2.3": true,
                    },
                    function (err) {
                        if (err) reject("Error writing cover art: " + err);
                        else resolve("ID3 info added.");
                    },
                );
            });
        case "flac":
            const tempMusicPath = musicPath + '.temp';

            return new Promise((resolve, reject) => {
                try {
                    const processor = new flacmetadata.Processor();

                    fs.renameSync(musicPath, tempMusicPath);
                    const reader = fs.createReadStream(tempMusicPath);
                    const writer = fs.createWriteStream(musicPath);

                    fileType.fromFile(coverPath).then((coverMime) => {
                        const vendor = "reference libFLAC 1.2.1 20070917";
                        const comments = [
                            `TITLE=${musicMeta.title}`,
                            `ALBUM=${musicMeta.album}`,
                            `DATE=${musicMeta.date}`,
                            `ARTIST=${musicMeta.artist}`,
                            `TRACKNUMBER=${musicMeta.track}`
                        ];
    
                        processor.on("preprocess", function (mdb) {
                            if (mdb.type === flacmetadata.Processor.MDB_TYPE_VORBIS_COMMENT) {
                                mdb.remove();
                            }
    
                            if (mdb.type === flacmetadata.Processor.MDB_TYPE_PICTURE) {
                                mdb.remove();
                            }
    
                            if (mdb.removed || mdb.isLast) {
                                let mdbPicture = flacmetadata.data.MetaDataBlockPicture.create(
                                    mdb.isLast, '', coverMime.mime, '', '', '', '', '', fs.readFileSync(coverPath)
                                );
                                this.push(mdbPicture.publish());

                                var mdbVorbis = flacmetadata.data.MetaDataBlockVorbisComment.create(
                                    mdb.isLast, vendor, comments
                                );
                                this.push(mdbVorbis.publish());

                                this.mdb.isLast = true;
                            }
                        });

                        reader.on('end', () => {
                            resolve();
                        });
                        reader.pipe(processor).pipe(writer);
                    });
                    
                } catch (e) {
                    reject(e);
                }
            }).finally(() => {
                if (fs.statSync(tempMusicPath).isFile() === true) {
                    fs.rmSync(tempMusicPath);
                }
            });
        default:
            break;
    }
};

const downloadMusic = async (idList) => {
    const downloadLimit = config.generic.download_limit <= idList.length
        ? config.generic.download_limit
        : idList.length;

    let download_counter = downloadLimit
        
    const downloadSleepTime = config.generic.download_sleep_time;
    const tempIdList = cloneDeep(idList);
    const syncedIdList = [];

    log.info('⏬ 开始下载音乐...');

    // 重试次数
    let retryCounter = 0;

    while (true) {
        if (retryCounter >= config.generic.retry_time) {
            log.warn(
                `⚠️ 重试${retryCounter}次后仍无法正常下载，自动跳过ID为${tempIdList.pop()}的歌曲，请手动检查！`
            )
        }
        if (download_counter === 0 || tempIdList.length === 0) {
            log.info(
                `✅ 本次同步结束，已同步音乐${downloadLimit - download_counter}首，剩余${tempIdList.length}首待同步，请稍后重新同步`
            );
            break;
        };

        log.info(
            `🚗 正在同步第${downloadLimit - download_counter + 1}首，列表剩余${tempIdList.length}首，本次下载剩余${download_counter}首`
        );

        const currentId = tempIdList.pop();

        try {
            // 获取歌曲详情
            let response = await request.get(`/song/detail?ids=${currentId}`);
            const musicDetail = response.data.songs[0];
            log.debug('歌曲详情: ' + JSON.stringify(musicDetail));

            const {
                // 歌曲名称
                musicName,
                // 专辑名称
                albumName,
                // 发行年代
                releaseYear,
                // 歌手名称
                artistName,
                // 碟片编号
                discIndex,
                // 曲目编号
                trackIndex,
            } = await parseMusicDetail(musicDetail);
            log.debug('歌曲详情(解析后): ' + JSON.stringify(await parseMusicDetail(musicDetail)));

            const tempCoverName = `${currentId}.jpg`;

            // 下载歌曲封面
            log.debug('下载歌曲封面');
            await (new Downloader({
                url: musicDetail.al.picUrl,
                directory: config.generic.cover_store_path,
                fileName: tempCoverName,
                cloneFiles: false,
            })).download();

            // 下载音乐文件
            log.debug('下载音乐文件');
            response = await request.get(`/song/url?id=${currentId}&br=${config.generic.music_bitrate}`);
            const musicDownloadInfo = response.data.data[0];
            log.debug('音乐下载信息详情: ' + JSON.stringify(musicDownloadInfo));

            const tempMusicName = `${currentId}.${musicDownloadInfo.type || 'mp3'}`;
            const musicFileName = filenamify(`${musicName} - ${artistName}`) + `.${musicDownloadInfo.type || 'mp3'}`;
            const lyricFileName = (() => {
                const musicFileNameArray = musicFileName.split('.');
                musicFileNameArray.pop();
                musicFileNameArray.push('lrc');
                return musicFileNameArray.join('.');
            })();
            log.debug('文件名: ' + musicFileName);

            // 没有资源，可能是版权问题
            if (musicDownloadInfo.code !== 200) {
                log.warn(`⚠️ 歌曲《${musicFileName}》无法下载，可能是由于没有版权导致，已自动跳过`);
                syncedIdList.unshift(currentId);
                download_counter -= 1;
                continue;
            }

            // 仅供试听
            if (musicDownloadInfo.freeTrialInfo !== null) {
                log.warn(`⚠️ 歌曲《${musicFileName}》仅供试听，可能是由于没有版权导致，已自动跳过`);
                syncedIdList.unshift(currentId);
                download_counter -= 1;
                continue;
            }

            await (new Downloader({
                url: musicDownloadInfo.url,
                directory: config.generic.temp_music_store_path,
                fileName: tempMusicName,
                cloneFiles: false,
            })).download();

            log.debug('集成ID3信息中');
            await id3Embed({
                musicPath: path.join(config.generic.temp_music_store_path, tempMusicName),
                coverPath: path.join(config.generic.cover_store_path, tempCoverName),
                musicMeta: {
                    title: musicName,
                    album: albumName,
                    date: releaseYear,
                    artist: artistName,
                    disc: discIndex,
                    track: trackIndex,
                }
            });

            // 下载歌词
            if (config.generic.download_lyric === true) {
                log.debug('下载歌词中');
                response = await request.get(`/lyric?id=${currentId}`);
                log.debug('歌词信息详情: ' + JSON.stringify(response.data));
                if (response.data.nolyric !== true && response.data.lrc) {
                    const lyric = response.data.lrc.lyric;
                    const lyricPath = path.join(config.generic.temp_music_store_path, lyricFileName);
                    fs.writeFileSync(lyricPath, lyric, {
                        encoding: 'utf-8',
                    });
                } else {
                    log.debug('没有歌词，跳过下载歌词...');
                }
            }

            // 移动文件到音乐目录
            log.debug('移动文件到音乐目录中');
            await fsPromised.rename(
                path.join(config.generic.temp_music_store_path, tempMusicName),
                path.join(config.generic.music_store_path, musicFileName),
            );

            if (fs.existsSync(path.join(config.generic.temp_music_store_path, lyricFileName))) {
                await fsPromised.rename(
                    path.join(config.generic.temp_music_store_path, lyricFileName),
                    path.join(config.generic.music_store_path, lyricFileName),
                );
            }

            // 检查文件有效性
            const fileInfo = await fileType.fromFile(`${config.generic.music_store_path}/${musicFileName}`);
            log.debug('文件类型: ' + fileInfo.mime);
            if (
                (fileInfo.ext === 'mp3' && fileInfo.mime === 'audio/mpeg')
                || (fileInfo.ext === 'flac' && fileInfo.mime === 'audio/x-flac')
            ) {
                download_counter--;
                syncedIdList.unshift(currentId);
                log.info(`🎉 ${musicFileName} 下载成功! 等待${downloadSleepTime}ms...`);
            } else {
                throw new Error('文件类型检查失败！文件可能已经损坏。');
            }
        } catch (e) {
            log.error('🚫 下载任务失败: ' + e);
            log.debug('重试次数为:' + retryCounter);
            // 把任务再塞回去
            tempIdList.push(currentId);
            // 重试次数+1
            retryCounter += 1;
        }

        log.debug('休眠时间为: ' + downloadSleepTime);
        await sleep(downloadSleepTime);
    }

    log.debug('已同步音乐数量: ' + syncedIdList.length);
    return syncedIdList;
}

const parseMusicDetail = async (musicDetail) => {
    // 歌曲名称
    let musicName;
    musicName = musicDetail.name;

    // 专辑名称
    let albumName;
    albumName = musicDetail.al.name;

    // 发行年代
    let releaseYear;
    releaseYear = (new Date(musicDetail.publishTime)).getFullYear();

    // 歌手名称
    let artistName;
    let ar = musicDetail.ar;
    ar = ar.map((eachArtist) => (eachArtist.name));
    // 避免歌手太多导致文件名过长
    artistName = ar.slice(0, 5).join(', ');

    // 碟片编号
    let discIndex;
    discIndex = musicDetail.cd;

    // 曲目编号
    let trackIndex;
    trackIndex = musicDetail.no;

    return {
        musicName, albumName, releaseYear, artistName, discIndex, trackIndex,
    };
}

const writeSyncedMusicList = async (syncedIdList) => {
    log.debug('新数据条数: ' + syncedIdList.length);

    // 读取旧数据
    log.debug('读取旧数据');
    const oldData = JSON.parse(fs.readFileSync('./data/playlist.json', 'utf-8'));
    log.debug('旧数据条数: ' + oldData.length);

    // 新旧数据合并
    log.debug('新旧数据合并');
    const newData = [...syncedIdList, ...oldData];

    // 写入新数据
    log.debug('写入新数据，条数: ' + newData.length);
    fs.writeFileSync('./data/playlist.json', JSON.stringify(newData));
}

(async () => {
    log.debug('欢迎文本');
    await welcome();

    // 登录
    log.debug('登录');
    const cookie = await login();
    log.debug('Cookie获取成功: ' + cookie);
    log.info('登录成功');

    log.debug('保存Cookie');
    await saveCookie(cookie);

    // 登录之后在每个请求的结尾都加上Cookie
    log.debug('在请求结尾添加Cookie');
    await request.interceptors.request.use(function (config) {
        log.debug('拦截请求成功，请求URL为: ' + config.url);
        const newUrl = urlParameterAppend(config.url, {
            cookie: encodeURIComponent(cookie),
        });
        log.debug('拦截后的新URL为: ' + newUrl);
        const newConfig = {
            ...config,
            url: newUrl,
        }
        return newConfig;
    });

    await sleep(2000);

    // 获取用户信息，主要目的是检查Cookie是否过期，顺便向用户展示其基础信息，提升用户体验
    log.debug('获取用户信息');
    await getUserInfo();

    // 获取播放列表
    log.debug('获取当前播放列表');
    const playlist = (await fetchPlaylist()).map((eachMusic) => ({ id: eachMusic.id }));
    log.info('播放列表长度为: ' + playlist.length);

    log.debug('与本地同步播放列表')
    // 与本地同步播放列表（只同步添加过的音乐）
    const addedMusic = await diffPlaylist(playlist);
    log.info('本次待同步音乐数量为: ' + addedMusic.length);
    
    // 下载音乐
    const syncedIdList = await downloadMusic(addedMusic);

    // 已同步音乐写入JSON文件
    await writeSyncedMusicList(syncedIdList);
})()
