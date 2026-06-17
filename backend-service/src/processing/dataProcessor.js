/**
 * System Design Note: Data Pruning
 * We compress the USGS payload to minimize network egress costs and frontend parsing overhead.
 */
function pruneSeismicData(rawGeoJson) {
    if (!rawGeoJson || !rawGeoJson.features) {
        return [];
    }

    return rawGeoJson.features.map(feature => {
        const { properties, geometry, id } = feature;
        
        return {
            id: id,
            magnitude: properties.mag,
            place: properties.place,
            time: properties.time,
            tsunami: properties.tsunami,
            coordinates: {
                longitude: geometry.coordinates[0],
                latitude: geometry.coordinates[1],
                depth: geometry.coordinates[2] // Depth in kilometers
            }
        };
    });
}

module.exports = { pruneSeismicData };