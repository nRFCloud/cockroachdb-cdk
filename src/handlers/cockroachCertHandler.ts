import { CustomResourceProviderRequest, CustomResourceProviderResponse } from '../lib/types';
import {SecretsManager, SSM} from 'aws-sdk'
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, read, readFileSync, write, writeFileSync } from 'fs';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { CockroachClientCertificates } from '../resources/cockroachClientCertificates';
import { create } from 'domain';

type CreateCockroachCARequest = CustomResourceProviderRequest<'Custom::CockroachCA', {}>
type CreateCockroachNodeCertificatesRequest = CustomResourceProviderRequest<'Custom::CockroachNodeCertificates', {
  caCrtParameter: string;
  caKeyParameter: string;
  domainNames: string[];
}>
type CreateCockroachClientCertificatesRequest = CustomResourceProviderRequest<'Custom::CockroachClientCertificates', {
  caCrtParameter: string;
  caKeyParameter: string;
  caSecret: string;
  username: string;
}>

type Request = CreateCockroachCARequest | CreateCockroachNodeCertificatesRequest | CreateCockroachClientCertificatesRequest;

export async function handler(event: Request) {
  let processor;
  switch (event.ResourceType) {
    case 'Custom::CockroachCA':
      processor = new CockroachCARequestProcessor(event);
      break;
    case 'Custom::CockroachNodeCertificates':
      processor = new CockroachNodeCertificateRequestProcessor(event);
      break;
    case 'Custom::CockroachClientCertificates':
      processor = new CockroachClientCertificateRequestProcessor(event);
      break;
  }

  switch (event.RequestType) {
    case 'Create':
      return processor.create();
    case 'Update':
      return processor.update();
    case 'Delete':
      await processor.delete();
  }
}

abstract class ResourceProcessor<T extends CustomResourceProviderRequest,R extends object> {
  public readonly event: T;
  constructor(event: T) {
    this.event = event;
  }
  abstract create(): Promise<CustomResourceProviderResponse<R>>
  abstract delete(): Promise<CustomResourceProviderResponse<R>>;
  abstract update(): Promise<CustomResourceProviderResponse<R>>
}

const certsDir = join(tmpdir(), randomUUID(), 'certs')
mkdirSync(certsDir, {recursive: true})
const SSMClient = new SSM();
const caKeyPath = join(certsDir, 'ca.key');
const caCrtPath = join(certsDir, 'ca.crt');

const indexPath = join(certsDir, 'index.txt');
const serialPath = join(certsDir, 'serial.txt');

const caCnfPath = join(certsDir, 'ca.cnf');
const caCnfContent = `# OpenSSL CA configuration file
[ ca ]
default_ca = CA_default

[ CA_default ]
default_days = 9999999
database = ${indexPath}
serial = ${serialPath}
default_md = sha256
copy_extensions = copy
unique_subject = no

# Used to create the CA certificate.
[ req ]
prompt=no
distinguished_name = distinguished_name
x509_extensions = extensions

[ distinguished_name ]
organizationName = Cockroach
commonName = Cockroach CA

[ extensions ]
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment,keyCertSign
basicConstraints = critical,CA:true,pathlen:1

# Common policy for nodes and users.
[ signing_policy ]
organizationName = supplied
commonName = optional

# Used to sign node certificates.
[ signing_node_req ]
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth,clientAuth

# Used to sign client certificates.
[ signing_client_req ]
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth`;
writeFileSync(caCnfPath, caCnfContent);

function hashString(string: string, chars = 6) {
  return createHash('sha1').update(string).digest().toString('hex').substr(0, chars)
}

async function saveCaKeyMaterial(caCrtParameter: string, caKeyParameter: string) {
  const [{Parameter: caKeyParam}, {Parameter: caCrtParam}] = await Promise.all([
    SSMClient.getParameter({Name: caKeyParameter, WithDecryption: true}).promise(),
    SSMClient.getParameter({Name: caCrtParameter, WithDecryption: true}).promise()
  ])
  const caKey = caKeyParam?.Value;
  const caCrt = caCrtParam?.Value;

  if (caKey == null || caCrt == null) {
    throw new Error('CA files were empty')
  }

  writeFileSync(caKeyPath, caKey);
  writeFileSync(caCrtPath, caCrt);
  return {caKey, caCrt};
}

function randomChars(bytes = 4) {
  return randomBytes(bytes).toString('hex')
}

function setupIndexFiles() {
  writeFileSync(join(certsDir, 'index.txt'), '');
  writeFileSync(join(certsDir, 'serial.txt'), '01');
}

class CockroachClientCertificateRequestProcessor extends ResourceProcessor<CreateCockroachClientCertificatesRequest, {clientCrtParameter: string, clientKeyParameter: string, username: string}> {
  physicalId = this.event.LogicalResourceId + hashString(JSON.stringify(this.event.ResourceProperties))
  clientCrtParameterName = `/${this.physicalId}/clientCrt`
  clientKeyParameterName = `/${this.physicalId}/clientKey`

  async create() {
    await saveCaKeyMaterial(this.event.ResourceProperties.caCrtParameter, this.event.ResourceProperties.caKeyParameter);
    setupIndexFiles();
    const clientCnf = `[ req ]
prompt=no
distinguished_name = distinguished_name
req_extensions = extensions

[ distinguished_name ]
organizationName = Cockroach
commonName = ${this.event.ResourceProperties.username}
${this.event.ResourceProperties.username === 'root' ? '\n[ extensions ]\nsubjectAltName = DNS:root' : ''}
`;
    const clientCnfPath = join(certsDir, 'client.cnf');
    writeFileSync(clientCnfPath, clientCnf);

    const clientKeyPath = join(certsDir, `client.${this.event.ResourceProperties.username}.key`);
    const clientCrtPath = join(certsDir, `client.${this.event.ResourceProperties.username}.crt`);
    const clientCsrPath = join(certsDir, `client.${this.event.ResourceProperties.username}.csr`);

    execFileSync('openssl', [
      'genrsa',
      '-out', clientKeyPath,
      '2048'
    ])

    execFileSync('openssl', [
      'req',
      '-new',
      '-config', clientCnfPath,
      '-key', clientKeyPath,
      '-out', clientCsrPath,
      '-batch'
    ]);

    execFileSync('openssl', [
      'ca',
      '-config', caCnfPath,
      '-keyfile', caKeyPath,
      '-cert', caCrtPath,
      '-policy', 'signing_policy',
      '-extensions', 'signing_client_req',
      '-out', clientCrtPath,
      '-outdir', certsDir,
      '-in', clientCsrPath,
      '-days', '99999',
      '-batch'
    ])

    const clientKey = readFileSync(join(certsDir, `client.${this.event.ResourceProperties.username}.key`), 'utf8')
    const clientCrt = readFileSync(join(certsDir, `client.${this.event.ResourceProperties.username}.crt`), 'utf8')

    await Promise.all([
      SSMClient.putParameter({
        Name: this.clientCrtParameterName,
        Overwrite: true,
        Tier: "Intelligent-Tiering",
        Value: clientCrt,
        Type: "SecureString",
      }).promise(),
      SSMClient.putParameter({
        Name: this.clientKeyParameterName,
        Overwrite: true,
        Value: clientKey,
        Tier: "Intelligent-Tiering",
        Type: "SecureString"
      }).promise()
    ])

    return {
      PhysicalResourceId: this.physicalId,
      Data: {clientCrtParameter: this.clientCrtParameterName, clientKeyParameter: this.clientKeyParameterName, username: this.event.ResourceProperties.username}
    }
  }

  async update() {
    return this.create();
  }

  async delete() {
    await SSMClient.deleteParameters({
      Names: [`/${this.event.PhysicalResourceId}/clientCrt`, `/${this.event.PhysicalResourceId}/clientKey`]
    }).promise()

    return {
      PhysicalResourceId: this.event.LogicalResourceId,
      Data: {clientCrtParameter: this.clientCrtParameterName, clientKeyParameter: this.clientKeyParameterName, username: this.event.ResourceProperties.username}
    }
  }
}

class CockroachNodeCertificateRequestProcessor extends ResourceProcessor<CreateCockroachNodeCertificatesRequest, {nodeCrtParameter: string, nodeKeyParameter: string}> {
  physicalId = this.event.LogicalResourceId + hashString(JSON.stringify(this.event.ResourceProperties))
  nodeCrtParameterName = `/${this.physicalId}/nodeCrt`
  nodeKeyParameterName = `/${this.physicalId}/nodeKey`

  async create() {
    await saveCaKeyMaterial(this.event.ResourceProperties.caCrtParameter, this.event.ResourceProperties.caKeyParameter);
    const nodeCnf = `# OpenSSL node configuration file
[ req ]
prompt=no
distinguished_name = distinguished_name
req_extensions = extensions

[ distinguished_name ]
organizationName = Cockroach
commonName = node

[ extensions ]
subjectAltName = critical,${this.event.ResourceProperties.domainNames.map(domain => `DNS:${domain}`).join(',')}`;
    const nodeCnfPath = join(certsDir, 'node.cnf');
    writeFileSync(nodeCnfPath, nodeCnf);

    const nodeKeyPath = join(certsDir, 'node.key');
    const nodeCrtPath = join(certsDir, 'node.crt');
    const nodeCsrPath = join(certsDir, 'node.csr');

    setupIndexFiles();

    // Generate key
    execFileSync('openssl', [
      'genrsa',
      '-out', nodeKeyPath,
      '2048'
    ])

    // Generate certificate signing request
    execFileSync('openssl', [
      'req',
      '-new',
      '-config', nodeCnfPath,
      '-key', nodeKeyPath,
      '-out', nodeCsrPath,
      '-batch'
    ])

    // Sign certificate
    execFileSync('openssl', [
      'ca',
      '-config', caCnfPath,
      '-keyfile', caKeyPath,
      '-cert', caCrtPath,
      '-policy', 'signing_policy',
      '-extensions', 'signing_node_req',
      '-out', nodeCrtPath,
      '-outdir', certsDir,
      '-in', nodeCsrPath,
      '-days', "99999",
      '-batch'
    ])

    const nodeKey = readFileSync(nodeKeyPath, 'utf8')
    const nodeCrt = readFileSync(nodeCrtPath, 'utf8')

    await Promise.all([
      SSMClient.putParameter({
        Name: this.nodeCrtParameterName,
        Overwrite: true,
        Value: nodeCrt,
        Type: "SecureString",
        Tier: "Intelligent-Tiering",
      }).promise(),
      SSMClient.putParameter({
        Name: this.nodeKeyParameterName,
        Overwrite: true,
        Value: nodeKey,
        Tier: "Intelligent-Tiering",
        Type: "SecureString"
      }).promise()
    ])

    return {
      PhysicalResourceId: this.physicalId,
      Data: {nodeCrtParameter: this.nodeCrtParameterName, nodeKeyParameter: this.nodeKeyParameterName}
    }
  }

  async update() {
    return this.create();
  }

  async delete() {
    await SSMClient.deleteParameters({
      Names: [`/${this.event.PhysicalResourceId}/nodeCrt`, `/${this.event.PhysicalResourceId}/nodeKey`]
    }).promise()

    return {
      PhysicalResourceId: this.event.LogicalResourceId,
      Data: {nodeCrtParameter: this.nodeCrtParameterName, nodeKeyParameter: this.nodeKeyParameterName}
    }
  }
}

class CockroachCARequestProcessor extends ResourceProcessor<CreateCockroachCARequest, {caCrtParameter: string, caKeyParameter: string}> {
  caCrtParameterName = `/${this.event.LogicalResourceId}/caCrt`
  caKeyParameterName = `/${this.event.LogicalResourceId}/caKey`

  async create() {

    // Generate key
    execFileSync("openssl", [
      "genrsa",
      "-out", caKeyPath,
      "2048"
    ]);

    // Generate certificate
    execFileSync("openssl", [
      "req",
      "-new",
      "-x509",
      "-config", caCnfPath,
      "-key", caKeyPath,
      "-out", caCrtPath,
      "-days", "2900000",
      "-batch"
    ])

    const caCrt = readFileSync(caCrtPath, 'utf8');
    const caKey = readFileSync(caKeyPath, 'utf8');

    await Promise.all([
      SSMClient.putParameter({
        Name: this.caCrtParameterName,
        Overwrite: true,
        Value: caCrt,
        Type: "SecureString",
        Tier: "Intelligent-Tiering",
      }).promise(),
      SSMClient.putParameter({
        Name: this.caKeyParameterName,
        Overwrite: true,
        Value: caKey,
        Type: "SecureString",
        Tier: "Intelligent-Tiering",
      }).promise()
    ])

    return {
      PhysicalResourceId: this.event.LogicalResourceId,
      Data: {caCrtParameter: this.caCrtParameterName, caKeyParameter: this.caKeyParameterName}
    }
  }

  async update() {
    return {
      PhysicalResourceId: this.event.LogicalResourceId,
      Data: {caCrtParameter: this.caCrtParameterName, caKeyParameter: this.caKeyParameterName}
    }
  }

  async delete() {
    await SSMClient.deleteParameters({
      Names: [this.caKeyParameterName, this.caCrtParameterName]
    }).promise()

    return {
      PhysicalResourceId: this.event.PhysicalResourceId,
      Data: {caCrtParameter: this.caCrtParameterName, caKeyParameter: this.caKeyParameterName}
    }
  }
}
