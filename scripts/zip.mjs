/*
 * 零依赖 ZIP 打包器（只用 Node 内置 zlib），跨平台可用。
 * 社区插件的 Release 只要三个文件，这里额外打一个 zip 方便用户整包下载。
 */

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = -1;
	for (let i = 0; i < buffer.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
	return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
	const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
	const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
	return { time, day };
}

/**
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer} zip 内容
 */
export function createZip(entries) {
	const now = dosDateTime(new Date());
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const crc = crc32(entry.data);
		const deflated = deflateRawSync(entry.data, { level: 9 });
		// 压缩后反而更大时退回 store，避免负优化
		const useDeflate = deflated.length < entry.data.length;
		const payload = useDeflate ? deflated : entry.data;
		const method = useDeflate ? 8 : 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flag: UTF-8 文件名
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(now.time, 10);
		local.writeUInt16LE(now.day, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);

		chunks.push(local, nameBuf, payload);

		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4); // version made by
		cd.writeUInt16LE(20, 6); // version needed
		cd.writeUInt16LE(0x0800, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt16LE(now.time, 12);
		cd.writeUInt16LE(now.day, 14);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(payload.length, 20);
		cd.writeUInt32LE(entry.data.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28);
		cd.writeUInt16LE(0, 30); // extra
		cd.writeUInt16LE(0, 32); // comment
		cd.writeUInt16LE(0, 34); // disk
		cd.writeUInt16LE(0, 36); // internal attrs
		cd.writeUInt32LE(0, 38); // external attrs
		cd.writeUInt32LE(offset, 42);
		central.push(cd, nameBuf);

		offset += local.length + nameBuf.length + payload.length;
	}

	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...chunks, centralBuf, end]);
}
