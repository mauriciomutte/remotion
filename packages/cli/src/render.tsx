import {bundle} from '@remotion/bundler';
import {
	ffmpegHasFeature,
	getActualConcurrency,
	getCompositions,
	renderFrames,
	stitchFramesToVideo,
	validateFfmpeg,
} from '@remotion/renderer';
import cliProgress from 'cli-progress';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {Internals} from 'remotion';
import {getFinalOutputCodec} from 'remotion/dist/config/codec';
import {getCompositionId} from './get-composition-id';
import {getConfigFileName} from './get-config-file-name';
import {getOutputFilename} from './get-filename';
import {getUserProps} from './get-user-props';
import {getImageFormat} from './image-formats';
import {loadConfigFile} from './load-config';
import {parseCommandLine} from './parse-command-line';
import {getUserPassedFileExtension} from './user-passed-output-location';

export const render = async () => {
	const args = process.argv;
	const file = args[3];
	const fullPath = path.join(process.cwd(), file);

	const configFileName = getConfigFileName();
	loadConfigFile(configFileName);
	parseCommandLine();
	const parallelism = Internals.getConcurrency();
	const shouldOutputImageSequence = Internals.getShouldOutputImageSequence();
	const userCodec = Internals.getOutputCodecOrUndefined();
	if (shouldOutputImageSequence && userCodec) {
		console.error(
			'Detected both --codec and --sequence (formerly --png) flag.'
		);
		console.error(
			'This is an error - no video codec can be used for image sequences.'
		);
		console.error('Remove one of the two flags and try again.');
		process.exit(1);
	}
	const codec = getFinalOutputCodec({
		codec: userCodec,
		fileExtension: getUserPassedFileExtension(),
		emitWarning: true,
	});
	if (codec === 'vp8' && !ffmpegHasFeature('enable-libvpx')) {
		console.log(
			"The Vp8 codec has been selected, but your FFMPEG binary wasn't compiled with the --enable-lipvpx flag."
		);
		console.log(
			'This does not work, please switch out your FFMPEG binary or choose a different codec.'
		);
	}
	if (codec === 'h265' && !ffmpegHasFeature('enable-gpl')) {
		console.log(
			"The H265 codec has been selected, but your FFMPEG binary wasn't compiled with the --enable-gpl flag."
		);
		console.log(
			'This does not work, please recompile your FFMPEG binary with --enable-gpl --enable-libx265 or choose a different codec.'
		);
	}
	if (codec === 'h265' && !ffmpegHasFeature('enable-libx265')) {
		console.log(
			"The H265 codec has been selected, but your FFMPEG binary wasn't compiled with the --enable-libx265 flag."
		);
		console.log(
			'This does not work, please recompile your FFMPEG binary with --enable-gpl --enable-libx265 or choose a different codec.'
		);
	}

	const outputFile = getOutputFilename(codec, shouldOutputImageSequence);
	const overwrite = Internals.getShouldOverwrite();
	const userProps = getUserProps();
	const quality = Internals.getQuality();

	const absoluteOutputFile = path.resolve(process.cwd(), outputFile);
	if (fs.existsSync(absoluteOutputFile) && !overwrite) {
		console.log(
			`File at ${absoluteOutputFile} already exists. Use --overwrite to overwrite.`
		);
		process.exit(1);
	}
	if (!shouldOutputImageSequence) {
		await validateFfmpeg();
	}
	const crf = shouldOutputImageSequence ? null : Internals.getActualCrf(codec);
	if (crf !== null) {
		Internals.validateSelectedCrfAndCodecCombination(crf, codec);
	}
	const pixelFormat = Internals.getPixelFormat();
	const imageFormat = getImageFormat(
		shouldOutputImageSequence ? undefined : codec
	);

	Internals.validateSelectedPixelFormatAndCodecCombination(pixelFormat, codec);
	Internals.validateSelectedPixelFormatAndImageFormatCombination(
		pixelFormat,
		imageFormat
	);
	if (shouldOutputImageSequence) {
		fs.mkdirSync(absoluteOutputFile, {
			recursive: true,
		});
	}
	const steps = shouldOutputImageSequence ? 2 : 3;
	process.stdout.write(`📦 (1/${steps}) Bundling video...\n`);

	const bundlingProgress = new cliProgress.Bar(
		{
			clearOnComplete: true,
			format: '[{bar}] {percentage}%',
		},
		cliProgress.Presets.shades_grey
	);

	bundlingProgress.start(100, 0);

	const bundled = await bundle(fullPath, (progress) => {
		bundlingProgress.update(progress);
	});
	const comps = await getCompositions(bundled);
	const compositionId = getCompositionId(comps);

	bundlingProgress.stop();

	const config = comps.find((c) => c.id === compositionId);
	if (!config) {
		throw new Error(`Cannot find composition with ID ${compositionId}`);
	}

	const {durationInFrames: frames} = config;
	const outputDir = shouldOutputImageSequence
		? absoluteOutputFile
		: await fs.promises.mkdtemp(path.join(os.tmpdir(), 'react-motion-render'));

	const renderProgress = new cliProgress.Bar(
		{
			clearOnComplete: true,
			etaBuffer: 50,
			format: '[{bar}] {percentage}% | ETA: {eta}s | {value}/{total}',
		},
		cliProgress.Presets.shades_grey
	);
	await renderFrames({
		config,
		onFrameUpdate: (frame) => renderProgress.update(frame),
		parallelism,
		compositionId,
		outputDir,
		onStart: () => {
			process.stdout.write(
				`📼 (2/${steps}) Rendering frames (${getActualConcurrency(
					parallelism
				)}x concurrency)...\n`
			);
			renderProgress.start(frames, 0);
		},
		userProps,
		webpackBundle: bundled,
		imageFormat,
		quality,
	});
	renderProgress.stop();
	if (process.env.DEBUG) {
		Internals.perf.logPerf();
	}
	if (!shouldOutputImageSequence) {
		process.stdout.write(`🧵 (3/${steps}) Stitching frames together...\n`);
		if (typeof crf !== 'number') {
			throw TypeError('CRF is unexpectedly not a number');
		}
		const stitchingProgress = new cliProgress.Bar(
			{
				clearOnComplete: true,
				etaBuffer: 50,
				format: '[{bar}] {percentage}% | ETA: {eta}s | {value}/{total}',
			},
			cliProgress.Presets.shades_grey
		);
		stitchingProgress.start(frames, 0);
		await stitchFramesToVideo({
			dir: outputDir,
			width: config.width,
			height: config.height,
			fps: config.fps,
			outputLocation: absoluteOutputFile,
			force: overwrite,
			imageFormat,
			pixelFormat,
			codec,
			crf,
			onProgress: (frame) => {
				stitchingProgress.update(frame);
			},
		});
		stitchingProgress.stop();

		console.log('Cleaning up...');
		await Promise.all([
			fs.promises.rmdir(outputDir, {
				recursive: true,
			}),
			fs.promises.rmdir(bundled, {
				recursive: true,
			}),
		]);
		console.log('\n▶️ Your video is ready - hit play!');
	} else {
		console.log('\n▶️ Your image sequence is ready!');
	}
	console.log(absoluteOutputFile);
};
