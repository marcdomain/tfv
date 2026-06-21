const { extractTargets, removeComments } = require('../lib/modules/terraform-command');

describe('removeComments', () => {
  test('removes # single-line comments', () => {
    const result = removeComments('resource "aws_instance" "web" { # this is a comment\n}');
    expect(result).not.toContain('this is a comment');
    expect(result).toContain('resource "aws_instance" "web"');
  });

  test('removes // single-line comments', () => {
    const result = removeComments('// this is a comment\nresource "aws_s3_bucket" "bucket" {}');
    expect(result).not.toContain('this is a comment');
    expect(result).toContain('resource "aws_s3_bucket" "bucket"');
  });

  test('removes /* */ block comments', () => {
    const content = '/* block\ncomment */\nresource "aws_vpc" "main" {}';
    const result = removeComments(content);
    expect(result).not.toContain('block');
    expect(result).toContain('resource "aws_vpc" "main"');
  });

  test('does not remove # inside strings', () => {
    const content = 'tags = { name = "web#1" } # this is a comment';
    const result = removeComments(content);
    expect(result).toContain('"web#1"');
    expect(result).not.toContain('this is a comment');
  });
});

describe('extractTargets', () => {
  const tfContent = `
resource "aws_instance" "web" {
  ami = "ami-12345"
}

resource "aws_s3_bucket" "logs" {}

data "aws_ami" "ubuntu" {}

module "vpc" {
  source = "./modules/vpc"
}
  `;

  test('extracts resource targets', () => {
    const targets = extractTargets(tfContent);
    expect(targets).toContain('aws_instance.web');
    expect(targets).toContain('aws_s3_bucket.logs');
  });

  test('extracts data source targets', () => {
    const targets = extractTargets(tfContent);
    expect(targets).toContain('data.aws_ami.ubuntu');
  });

  test('extracts module targets', () => {
    const targets = extractTargets(tfContent);
    expect(targets).toContain('module.vpc');
  });

  test('returns empty array for empty content', () => {
    expect(extractTargets('')).toEqual([]);
  });

  test('ignores commented-out resources', () => {
    const commented = `
# resource "aws_instance" "commented" {}
resource "aws_instance" "real" {}
    `;
    const targets = extractTargets(commented);
    expect(targets).not.toContain('aws_instance.commented');
    expect(targets).toContain('aws_instance.real');
  });
});
