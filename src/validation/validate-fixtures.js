const { listRecordTypes } = require("./schema-registry");
const { EcitrValidator } = require("./validator");

function main() {
  const validator = new EcitrValidator();

  for (const recordType of listRecordTypes()) {
    validator.validateFixture(recordType);
    console.log(`validated fixture: ${recordType}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
