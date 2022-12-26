const https = require('https');

exports.fetchAllVersions = async () => {
	try {
		return new Promise((resolve, reject) => {
			https.get('https://releases.hashicorp.com/terraform/', (resp) => {
				let data = '';

				resp.on('data', (chunk) => data += chunk);
				resp.on('end', () => resolve(data));
			}).on("error", (err) => {
					reject(err);
			});
		});
	} catch ({message}) {
		console.log('ERROR:', message);
	}
};
