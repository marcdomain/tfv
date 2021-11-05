const client = require('https');

const getAvailableVersions = (url) => {
	return new Promise((resolve, reject) => {
		client.get(url, (resp) => {
			let data = '';

			// A chunk of data has been received.
			resp.on('data', (chunk) => {
				data += chunk;
			});

			// The whole response has been received. Print out the result.
			resp.on('end', () => {
				resolve(data);
			});
		}).on("error", (err) => {
				reject(err);
		});
	});
};

exports.fetchAllVersions = async () => {
	const content = await getAvailableVersions('https://releases.hashicorp.com/terraform/');
	const pattern = /(>terraform_).*(?=<\/a>)/g;
	const versions = content.match(pattern).map(v => v.replace('>terraform_', ''));

	return versions;
};
