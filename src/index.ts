import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Stream } from 'node:stream'

import { Context, z, Service, SessionError, h } from 'koishi'

import Tesseract, { createWorker } from 'tesseract.js'

export const name = 'w-tesseract'

export const inject = [ 'http' ]

declare module 'koishi' {
    interface Context {
        tesseract: TesseractService
    }
}

const streamToBuffer = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
    const buffers: Uint8Array[] = []
    for await (const data of stream) buffers.push(data)
    return Buffer.concat(buffers)
}

class TesseractService extends Service {
    logger = this.ctx.logger('w-tesseract')

    get langPath() {
        return path.resolve(this.ctx.baseDir, this.config.langPath)
    }

    constructor(ctx: Context, public config: TesseractService.Config) {
        super(ctx, 'tesseract')

        ctx.command('tesseract', 'Tesseract.js 服务')

        ctx.command('tesseract.lang', '管理 Tesseract.js 语言训练数据')

        ctx.command('tesseract.lang.list', '列出所有语言')
            .action(async () => {
                const langs = await this.getInstalledLangs()
                return `已安装的语言：${ langs.join(', ') || '无' }`
            })

        ctx.command('tesseract.lang.install <lang:string>', '安装语言')
            .action(async (_, lang) => {
                try {
                    await this.installLang(lang)
                }
                catch (err) {
                    this.logger.error(`安装 ${lang} 的训练数据时出错: %o`, err)
                    throw new SessionError(`安装 ${lang} 的训练数据时出错：${err}`)
                }

                const langs = await this.getInstalledLangs()
                return `安装 ${lang} 的训练数据成功，当前已安装的语言：${ langs.join(', ') }`
            })

        ctx.command('tesseract.recognize <content:text>', '识别图片中文字')
            .option('langs', '-l <langs:string> 指定语言，多语言用逗号（,）分隔')
            .option('json', '-j 在控制台打印 JSON 结果')
            .action(async ({ session, options }, content) => {
                const imgEl = h.parse(content).find(el => el.type === 'img')
                if (! imgEl) return '请在命令中附带图片'

                const { src } = imgEl.attrs
                const stream = await ctx.http.get(src, { responseType: 'stream' })
                const buffer = await streamToBuffer(stream)
                session.send('图片下载完成，开始识别……')

                const langs = options.langs
                    ? options.langs.split(',')
                    : (await this.getInstalledLangs()).slice(0, 1)
                const worker = await this.createWorker(langs)
                const res = await worker.recognize(buffer)
                worker.terminate()

                if (options.json) this.logger.info('识别结果 JSON: %o', res)
                return `识别结果：${res.data.text}`
            })
    }

    async installLang(lang: string) {
        const gzipFileName = `${lang}.traineddata.gz`
        const gzipFilePath = path.resolve(this.langPath, gzipFileName)
        const url = this.config.source.replace(/{lang}/g, lang).replace(/{file}/g, gzipFileName)

        this.logger.info(`正在下载训练数据 <${url}> 到 <${gzipFilePath}>……`)
        const resp = await this.ctx.http.get(url, {
            responseType: 'stream',
            timeout: this.config.downloadTimeout
        })
        await fs.mkdir(this.langPath, { recursive: true })
        await resp.pipeTo(Stream.Writable.toWeb(fsSync.createWriteStream(gzipFilePath)))

        this.logger.info('安装成功')
    }

    async installNecessaryLangs(langs: string[]) {
        const installedLangs = await this.getInstalledLangs()
        await Promise.all(langs
            .filter(lang => ! installedLangs.includes(lang))
            .map(lang => this.installLang(lang))
        )
    }

    async getInstalledLangs() {
        try {
            await fs.mkdir(this.langPath, { recursive: true })
            const dir = await fs.readdir(this.langPath)
            return dir.filter(s => s.endsWith('.traineddata.gz')).map(s => s.slice(0, - 15))
        }
        catch (err) {
            this.logger.error(`刷新语言列表时出错: %o`, err)
            return []
        }
    }

    async createWorker(langs: string[], options: Partial<Tesseract.WorkerOptions> = {}) {
        const installedLangs = await this.getInstalledLangs()
        const missingLangs = langs.filter(lang => ! installedLangs.includes(lang))
        if (missingLangs.length) throw new SessionError(`缺失 Tesseract.js 语言训练数据：${ missingLangs.join(', ') }`)

        return createWorker(langs, 1, {
            langPath: this.langPath,
            ...options
        })
    }
}

namespace TesseractService {
    export interface Config {
        langPath: string
        source: string
        downloadTimeout: number
    }

    export const Config: z<Config> = z.object({
        langPath: z
            .path({
                filters: [ 'directory' ],
                allowCreate: true
            })
            .description('存放 Tesseract.js 语言训练数据的路径')
            .default('data/tesseract'),
        source: z
            .string()
            .description('Tesseract.js 训练数据下载源')
            .default('https://unpkg.com/@tesseract.js-data/{lang}/4.0.0_best_int/{file}'),
        downloadTimeout: z
            .natural()
            .description('下载超时时间（毫秒）')
            .default(30000)
    })
}

export default TesseractService