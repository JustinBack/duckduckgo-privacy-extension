/* Collect ToSDR data and process the privacy related points in defined in scripts/tosdr-topics.json 
 * We will use this processed data in our grade calculation. The process data is written to data/tosdr.json
 *
 * The list is updated when you run `make` or `make release`
 */
const request = require('request-promise')
const topics = require('./tosdr-topics.json')
const fs = require('fs')
const tldts = require('tldts')
let processed = {}
let nProcessed = 0;
let cachedCases = [];

const ratings = {
    0x1: "A",
    0x2: "B",
    0x4: "C",
    0x8: "D",
    0x10: "E",
    0x20: "N/A"
}



let allServiceRequest = {
    url: `https://api.tosdr.org/all-services/v1/`,
    headers: {
        'User-Agent': 'DuckDuckGo Privacy Extension (+https://github.com/duckduckgo/duckduckgo-privacy-extension)',
        'Authorization': process.env.TOSDR_APIKEY
    }
};

/* https://stackoverflow.com/a/13448477 */
const snooze = ms => new Promise(resolve => setTimeout(resolve, ms));


async function getSites() {

    if (!process.env.TOSDR_APIKEY) {
        console.log("WARNING! API KEY IS NOT SET, RATE LIMITS MAY OCCURR!");
        await snooze(5000);
    }

    // get the full list of tosdr sites.


    await request.get(allServiceRequest, async (err, res, body) => {
        if (res.statusCode == 429) {
            console.log("Too many requests, please wait until the rate limit is over! You may consult https://docs.tosdr.org/x/UIAF");
            return;
        }
        try {
            let sites = JSON.parse(body).parameters.services;

            // recurse through sites list. Get and process the detailed points data for each
            await getSitePoints(sites).then(result => {
                fs.writeFile(__dirname + '/../shared/data/tosdr.json', JSON.stringify(processed, null, 4), err => { if (err) console.log(err) });
                console.log("File written!");
            })
        } catch (e) {
            console.log(`http error getting all service data`, e);
        }
    })
}

async function getSitePoints(sites) {




    return new Promise(async (resolve, reject) => {

        if (sites.length === 0) {
            return resolve()
        }

        let site = encodeURIComponent(sites.pop().id);

        let restServiceRequest = {
            url: `https://api.tosdr.org/rest-service/v3/${site}.json`,
            headers: {
                'User-Agent': 'DuckDuckGo Privacy Extension (+https://github.com/duckduckgo/duckduckgo-privacy-extension)',
                'Authorization': process.env.TOSDR_APIKEY
            }
        };


        nProcessed += 1


        if (nProcessed % 5 === 0) process.stdout.write('.')

        console.log("Requesting service details", site);
        // get the detailed points data for this site
        await request.get(restServiceRequest, async (err, res, body) => {

            if (res.statusCode == 429) {
                console.log("Too many requests, please wait until the rate limit is over! You may consult https://docs.tosdr.org/x/AYA1");
                throw new Error("Too many requests");
            }

            if (res.statusCode !== 200) {
                console.log(`http error getting privacy data for: ${site}`, res.statusCode);
                return resolve(getSitePoints(sites))
            }

            if (err) {
                console.log(`request error getting privacy data for: ${site}`, err);
                return resolve(getSitePoints(sites))
            }

            let points = { score: 0, all: { bad: [], good: [] }, match: { bad: [], good: [] } }
            let allData

            try {
                allData = JSON.parse(body)
            } catch (e) {
                console.log(`json error getting privacy data for: ${site}`, e);
                return resolve(getSitePoints(sites))
            }

            let pointsData = allData.parameters.points
            let relatedUrls = allData.parameters.urls || []

            points.class = ratings[allData.parameters.rating]

            console.log("Iterating points", pointsData.length);
            for (pointName in pointsData) {



                let score = 0;
                let point = pointsData[pointName];



                if (point.status !== 'approved') {
                    continue;
                }

                let pointCase = point.case_id;
                console.log("Found case", pointCase);
                if (!pointCase) continue;

                let restCaseRequest = {
                    url: `https://api.tosdr.org/case/v1/${pointCase}.json`,
                    headers: {
                        'User-Agent': 'DuckDuckGo Privacy Extension (+https://github.com/duckduckgo/duckduckgo-privacy-extension)',
                        'Authorization': process.env.TOSDR_APIKEY
                    }
                };

                if (!cachedCases.some(function (el) { return el.id === pointCase; })) {
                    console.log("Requesting case details and adding to cache", pointCase);
                    await snooze(200);
                    await request.get(restCaseRequest, async (err, res, body) => {
                        try {
                            let caseData = JSON.parse(body).parameters;

                            cachedCases.push(caseData);

                            // standardize case (some of them start with caps)
                            pointCase = caseData.title.toLowerCase()
                            score = parseInt(caseData.score, 10);

                            let type = caseData.classification

                            if (type === 'good' || type === 'bad') {
                                addPoint(points, type, pointCase, score);
                            }
                        } catch (e) {
                            console.log(`error getting case data for: ${pointCase}`, e);
                        }
                    });
                } else {



                    let caseData = cachedCases[cachedCases.findIndex(function (caseobj) {
                        return caseobj.id == pointCase;
                    })];

                    if (!caseData) {
                        console.log("Failed to find cached case!", pointCase);
                        continue;
                    }

                    console.log("Found cached case", caseData.id);

                    pointCase = caseData.title.toLowerCase()
                    score = parseInt(caseData.score, 10);

                    let type = caseData.classification

                    if (type === 'good' || type === 'bad') {
                        addPoint(points, type, pointCase, score);
                    }
                }
            }

            // we use class in our score but we may not have privacy-related reasons for it
            // so show all available reasons instead
            if (points.class &&
                (!points.match.good || !points.match.good.length) &&
                (!points.match.bad || !points.match.bad.length)) {
                points.match.good = points.all.good
                points.match.bad = points.all.bad
            }

            if (!allData.url && relatedUrls) {
                allData.url = relatedUrls.shift()
            }

            if (allData.url) {
                const parsedUrl = tldts.parse(allData.url)
                processed[parsedUrl.domain] = points

                // link related sites with the same points
                relatedUrls.forEach((url) => {
                    processed[url] = points
                })
            }
            console.log("Sleeping...", 200);
            await snooze(200);
            return resolve(getSitePoints(sites));
        })
    });
}

function addPoint(points, type, pointCase, score) {

    points['all'][type].push(pointCase)

    // is this a point we care about
    if (topics[type].indexOf(pointCase) !== -1 &&
        // avoid adding duplicate points
        points['match'][type].indexOf(pointCase) === -1) {
        points['match'][type].push(pointCase)

        if (type === 'bad') {
            points.score += score
        } else {
            points.score -= score
        }
    }
}

getSites()
