import { mkdirSync, writeFileSync } from 'fs';
import {CloudFormation, SSM} from 'aws-sdk'
import { join } from 'path';


const CFClient = new CloudFormation();
const SSMClient = new SSM();

async function main() {
  const stackName = process.argv[2] || 'cockroach-ecs-test';
  const certsDir = process.argv[3] || 'certs';

  mkdirSync(certsDir, {recursive: true})
  const {Stacks: stacks} = await CFClient.describeStacks({
    StackName: stackName,
  }).promise()

  const outputs = stacks?.[0]?.Outputs

  if (outputs == null) {
    throw new Error("Can't get stack outputs");
  }

  const outputMap = outputs.reduce((map: {[key: string]: string}, output) => {
    const key = output.ExportName || output.OutputKey;
    if (key != null) {
      map[key] = output.OutputValue || "";
    }
    return map;
  }, {} as {[key: string]: string})

  console.log(outputMap)
  const [
    {Parameter: {Value: rootCrt} = {Value: ""}},
    {Parameter: {Value: rootKey} = {Value: ""}},
    {Parameter: {Value: caCrt} = {Value: ""}}
  ] = await Promise.all([
    SSMClient.getParameter({Name: outputMap.rootCrtParam, WithDecryption: true}).promise(),
    SSMClient.getParameter({Name: outputMap.rootKeyParam, WithDecryption: true}).promise(),
    SSMClient.getParameter({Name: outputMap.caCrtParam, WithDecryption: true}).promise(),
  ]);

  writeFileSync(join(certsDir, 'client.root.crt'), rootCrt || "", {mode: 0o600})
  writeFileSync(join(certsDir, 'client.root.key'), rootKey || "", {mode: 0o600})
  writeFileSync(join(certsDir, 'ca.crt'), caCrt || "", {mode: 0o600})
}

main()
