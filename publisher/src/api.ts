import firebase from 'firebase-admin';
import {DocumentData, getFirestore} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';
import {info} from 'firebase-functions/logger';
import {defineSecret} from 'firebase-functions/params';
import {https} from 'firebase-functions/v2';
import {chunk} from 'lodash';

const hakatashiApiKey = defineSecret('HAKATASHI_API_KEY');

export const getTopImages = https.onRequest(
	{
		cors: true,
		secrets: [hakatashiApiKey],
	},
	async (req, res) => {
		const {
			date,
			model: rawModel = '',
			category: rawCategory = '',
			apikey: rawApikey = '',
			cursor: rawCursor = '',
		} = req.query;
		if (rawApikey.toString() !== hakatashiApiKey.value()) {
			res.status(403).send('Invalid API key');
			return;
		}

		const model = rawModel.toString();
		const category = rawCategory.toString();
		if (!model.match(/^[0-9a-z_]+$/i) || !category.match(/^[0-9a-z_]+$/i)) {
			res.status(400).send('Invalid model or category');
			return;
		}

		const cursor = parseFloat(rawCursor.toString()) || Number.MAX_VALUE;

		const db = getFirestore();
		const result = await db.collection('images')
			.where('date', '==', date)
			.where(`inferences.${model}.${category}`, '<', cursor)
			.orderBy(`inferences.${model}.${category}`, 'desc')
			.limit(100)
			.get();

		const pixivInfos = new Map<number, DocumentData>();
		const pixivPages = new Map<number, DocumentData>();
		const pixivArtworkIds = result.docs
			.filter((doc) => doc.data().type === 'pixiv')
			.map((doc) => doc.data().artworkId);
		info(`Fetching ${pixivArtworkIds.length} pixiv artworks`);
		if (pixivArtworkIds.length > 0) {
			for (const artworkIds of chunk(pixivArtworkIds, 30)) {
				const pixivRankings = await db.collection('pixivRanking')
					.where('artwork.illust_id', 'in', artworkIds)
					.get();
				for (const doc of pixivRankings.docs) {
					const data = doc.data();
					if (data?.artwork?.illust_id) {
						pixivInfos.set(data.artwork.illust_id, data);
					}
				}
				const pixivPageResults = await db.collection('pixivPages')
					.where(firebase.firestore.FieldPath.documentId(), 'in', artworkIds.map((id) => id.toString()))
					.get();
				for (const doc of pixivPageResults.docs) {
					const data = doc.data();
					pixivPages.set(parseInt(doc.id), data);
				}
			}
		}

		const danbooruInfos = new Map<number, DocumentData>();
		const danbooruPostIds = result.docs
			.filter((doc) => doc.data().type === 'danbooru')
			.map((doc) => doc.data().postId);
		info(`Fetching ${danbooruPostIds.length} danbooru posts`);
		if (danbooruPostIds.length > 0) {
			for (const postIds of chunk(danbooruPostIds, 30)) {
				const danbooruRankings = await db.collection('danbooruRanking')
					.where('post.id', 'in', postIds)
					.get();
				for (const doc of danbooruRankings.docs) {
					const data = doc.data();
					if (data?.post?.id) {
						danbooruInfos.set(data.post.id, data);
					}
				}
			}
		}

		const storage = getStorage();
		const bucket = storage.bucket('danbooru-ml-classifier-images');

		info(`Signing ${result.docs.length} images`);
		const images = result.docs.map(async (doc) => {
			const data = doc.data();

			let width = 0;
			let height = 0;
			if (data.type === 'pixiv') {
				const pixivInfo = pixivInfos.get(data.artworkId);
				if (pixivInfo) {
					Object.assign(data, pixivInfo);
				}

				const pixivPage = pixivPages.get(data.artworkId);
				if (pixivPage) {
					width = pixivPage?.pages?.[data.page]?.width || 0;
					height = pixivPage?.pages?.[data.page]?.height || 0;
				}
			} else if (data.type === 'danbooru') {
				const danbooruInfo = danbooruInfos.get(data.postId);
				if (danbooruInfo) {
					width = danbooruInfo.post.image_width;
					height = danbooruInfo.post.image_height;
					Object.assign(data, danbooruInfo);
				}
			}

			const [url] = await bucket.file(data.key).getSignedUrl({
				version: 'v4',
				action: 'read',
				expires: Date.now() + 15 * 60 * 1000,
			});
			return {
				...data,
				width,
				height,
				url,
				score: data.inferences[model][category],
			};
		});

		res.json(await Promise.all(images));
	},
);
