const { OpenCloudAssetManager } = require("rblx")
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const probe = require('ffmpeg-probe');
const Spritesmith = require('spritesmith');
const chalk = require("chalk");
const imageSize = require("image-size")
const commander = require('commander');
const readline = require('readline');

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});


commander
  .option('-i, --input <path>', 'Input video. Required.')
  .option('-f', '--fps <number>', 'Capture FPS.', 30)
  .option('-r', '--res <number>', 'Capture resolution.', 170)
  .option('-nu', 'When set, the program will not automatically upload spritesheet output.', true)
  .parse(process.argv);

const options = commander.opts();

const videoPath = options.input || (console.log(chalk.red("missing video argument, exiting process")), commander.help(), process.exit())
if (!videoPath.endsWith('.mp4') || !fs.existsSync(videoPath)) {
	console.log(chalk.red("video argument is not a .mp4 or doesn't exist"))
	process.exit()
}
const fps = options.fps || (console.log(chalk.yellow("missing fps argument #2 (--fps), defaulting to 15")), 30)
const resolution = options.res || (console.log(chalk.yellow("missing resolution argument #3 (--r), defaulting to 170")), 170)
const upload = !options.nu

console.log(options)
if (resolution == 1024) {
	console.warn(chalk.yellow("resolution is set to 1024 - this means each frame is a single image"))
}
if (resolution >= 1024) {
	console.log(chalk.red("resolution cant be larger than 1024"))
	process.exit()
}

const config = JSON.parse(fs.readFileSync("config.json"))
const assetManager = new OpenCloudAssetManager(config.id)
assetManager.authenticate(config.key)

function mkdir(path) {
	if (!fs.existsSync(path)) {
		fs.mkdirSync(path)
	} else {
		console.warn(chalk.grey(`dir "${path}" already exists`))
	}
	return path
}

function cleardir(dirpath) {
	if (fs.existsSync(dirpath)) {
		fs.readdir(dirpath, (err, files) => {
			if (err) throw err;

			for (const file of files) {
				fs.unlink(path.join(dirpath, file), (err) => {
					if (err) throw err;
				});
			}
		});
	}
}

mkdir("out")
const framesOutput = "out/frames"
const spritesheetsOutput = "out/spritesheets"
cleardir(framesOutput)
cleardir(spritesheetsOutput)
mkdir(framesOutput)
mkdir(spritesheetsOutput)

const framesPerImage = Math.round(1024 / resolution)

console.log(chalk.blueBright("res: ") + chalk.cyan(resolution))
console.log(chalk.blueBright("fps: ") + chalk.cyan(fps))
console.log(chalk.blueBright("inp: ") + chalk.cyan(videoPath))

console.log(chalk.blueBright("frames per spritesheet: ") + chalk.cyan(framesPerImage))

const spritesheets = []

const noop = () => {};
async function processVideo(opts) {
	const {
		log = noop,
			input,
			output,
			timestamps,
			offsets,
			fps,
			numFrames,
			ffmpegPath,
			resolution,
	} = opts;

	if (!input) throw new Error('missing required input');
	if (!output) throw new Error('missing required output');

	const outputPath = path.parse(output);

	if (ffmpegPath) {
		ffmpeg.setFfmpegPath(ffmpegPath);
	}

	const cmd = ffmpeg(input).on('start', (cmd) => log({
		cmd
	}));

	if (timestamps || offsets) {
		const folder = outputPath.dir;
		const filename = outputPath.base;

		return new Promise((resolve, reject) => {
			cmd
				.on('end', () => resolve(output))
				.on('error', (err) => reject(err))
				.screenshots({
					folder,
					filename,
					timestamps: timestamps || offsets.map((offset) => offset / 1000),
				});
		});
	} else {
		let vfFilter = '';

		if (resolution) {
			vfFilter += `scale=-1:${resolution}`;
		}

		if (fps) {
			cmd.outputOptions(['-r', Math.max(1, fps | 0)]);
		} else if (numFrames) {
			const info = await probe(input);
			const numFramesTotal = parseInt(info.streams[0].nb_frames);
			const nthFrame = (numFramesTotal / numFrames) | 0;

			cmd.outputOptions(['-vsync', 'vfr']);

			vfFilter += `,select=not(mod(n\\,${nthFrame})`;
		}

		if (vfFilter !== '') {
			cmd.outputOptions(['-vf', vfFilter]);
		}

		if (outputPath.ext === '.raw') {
			cmd.outputOptions(['-pix_fmt', 'rgba']);
		}

		return new Promise((resolve, reject) => {
			cmd
				.on('end', () => resolve(output))
				.on('error', (err) => reject(err))
				.output(output)
				.run();
		});
	}
};

async function processSpritesheet(images, sheets) {
	return new Promise(resolve => {
		Spritesmith.run({
			src: images,
			algorithm: "binary-tree"
		}, async (err, spriteResult) => {
			if (err) {
				throw err;
			}
			const spritesheetFile = spritesheetsOutput + `/spritesheet-${sheets}.jpg`
			console.log(chalk.magenta("processed spritesheet " + sheets))
			fs.writeFileSync(spritesheetFile, spriteResult.image)
			spritesheets.push(spritesheetFile)
			resolve()
		})
	})
}

process.on("exit", () => console.log(chalk.green("exiting...")))

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

(async function() {
	const format = "frame-%d.jpg"
	await processVideo({
		fps: fps,
		resolution: resolution,
		input: videoPath,
		output: framesOutput + "/" + format,
		log: d => console.log(d.cmd)
	})

	const files = await fs.readdirSync(framesOutput)
	let images = []
	let count = 0
	let sheets = 0
	async function next(index) {
		if (index == files.length) {
			if (upload) {
				console.log(chalk.green("reached end of directory, uploading"))
				const size = imageSize(framesOutput + "/frame-1.jpg")
				let source = `local video = {w = ${size.width}, h = ${size.height}, fps = ${fps}, frames = {`
				let i = 0
				let done = 0
				for (const file of spritesheets) {
					i++
					const index = i
					await assetManager.createAsset("Decal", file, "spritesheet-" + index).then(uploadResult => {
						console.log(chalk.green("uploaded " + index))
						if (uploadResult) {
							const updateId = setInterval(async () => {
								const operationResult = await assetManager.getOperation(uploadResult.operationId)
								if (operationResult.done) {
									clearInterval(updateId)
									const id = operationResult.response.assetId
									console.log(chalk.greenBright(id))
									source += `\n\t[${index}] = ${id},`
									done++
									if (done == spritesheets.length) {
										fs.writeFileSync("out/output.lua", source + "\n}}")
										console.log(chalk.green("saved frames to " + path.join(__dirname, "out", "output.lua")))
										process.exit() // WE DONE
									}
								}
							}, 800);
						} else {
							console.log(chalk.red("failed to upload!"))
						}
					})
                    await sleep(500)
				}
			} else {
				console.log(chalk.green("reached end of directory, saved spritesheet images to " + path.join(__dirname, spritesheetsOutput)))
				process.exit()
			}
			return
		}
		const file = format.replace('%d', index + 1)
		count++
		const filePath = path.join(framesOutput, file);
		images.push(filePath)
		console.log(chalk.green(file))
		if (count == framesPerImage) {
			count = 0
			sheets++
			await processSpritesheet(images, sheets)
			images = []
		}
		next(index + 1)
	}
	await next(0)
})()
