/*
	MIT License

	Copyright (c) 2019 github0null

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
*/

import { AbstractProject } from "./EIDEProject";
import { File } from "../lib/node-utility/File";
import { ArmBaseCompileData } from "./EIDEProjectModules";
import { ResManager } from "./ResManager";
import { GlobalEvent } from "./GlobalEvents";
import { newMessage } from "./Message";
import { HexUploaderType, JLinkOptions, STVPFlasherOptions, ProtocolType, PyOCDFlashOptions, OpenOCDFlashOptions } from "./HexUploader";
import { jsonc } from 'jsonc';
import * as YAML from 'yaml';
import { SettingManager } from "./SettingManager";

interface Configuration {
    type: string;
    name: string;
    [key: string]: any;
}

interface LaunchConfig {
    version: string;
    configurations: Configuration[];
}

export abstract class IDebugConfigGenerator {

    protected launchFile: File | undefined;
    protected config: LaunchConfig;
    protected abstract project: AbstractProject;

    private loadOk: boolean;

    constructor() {
        this.loadOk = false;
        this.config = this._getDefaultConfig();
    }

    static newInstance(prj: AbstractProject): IDebugConfigGenerator {
        return new DebugGenerator(prj);
    }

    load(_launchFile: File): void {
        try {
            this.launchFile = _launchFile;
            this.config = _launchFile.IsFile() ? jsonc.parse(_launchFile.Read()) : this._getDefaultConfig();
            this.loadOk = true;
        } catch (error) {
            this.loadOk = false;
            const msg = `launch.json('${_launchFile.path}') format error !, msg:${(<Error>error).message}`;
            GlobalEvent.emit('msg', newMessage('Warning', msg));
        }
    }

    update(): void {
        if (this.launchFile && this.loadOk) {
            this._updateConfig(this.config);
            this.launchFile.Write(jsonc.stringify(this.config, undefined, 4));
        }
    }

    private _getDefaultConfig(): LaunchConfig {
        return {
            version: '0.2.0',
            configurations: []
        };
    }

    protected abstract _updateConfig(config: LaunchConfig): void;
}

class DebugGenerator extends IDebugConfigGenerator {

    private providerMap: Map<string, IDebugConfigProvider>;
    protected project: AbstractProject;

    constructor(prj: AbstractProject) {
        super();
        this.project = prj;
        this.providerMap = new Map();

        // register providers
        this.add(new cppdbgConfigProvider());
        this.add(new CortexDebugConfigProvider());
        this.add(new STM8DebugConfigProvider());
    }

    private add(provider: IDebugConfigProvider) {
        this.providerMap.set(provider.typeTag, provider);
    }

    protected _updateConfig(config: LaunchConfig): void {

        const uploader: HexUploaderType = this.project.GetConfiguration().uploadConfigModel.uploader;

        for (const gener of this.providerMap.values()) {
            // match toolchain
            if (gener.hexUploaderMatcher.includes(uploader)) {
                console.log(uploader);
                gener.update(this.project, config.configurations);
            }
        }
    }
}

abstract class IDebugConfigProvider {
    readonly abstract typeTag: string;
    readonly abstract hexUploaderMatcher: HexUploaderType[];
    abstract update(prj: AbstractProject, config_list: Configuration[]): void;
}

//============================== configuartion provider ====================================

class cppdbgConfigProvider extends IDebugConfigProvider {

    typeTag: string = 'cppdbg';

    hexUploaderMatcher: HexUploaderType[] = ['OpenOCD'];

    private openocdConnectConfig = {
        miDebuggerServerAddress: 'localhost:3333',
        useExtendedRemote: true,
        filterStderr: true,
        filterStdout: false,
        serverStarted: 'Listening on port 4444 for telnet connections'
    };

    update(prj: AbstractProject, config_list: Configuration[]): void {

        const prjConfig = prj.GetConfiguration<any>().config;
        const uploader = prj.GetConfiguration().uploadConfigModel.uploader;
        const uploader_name = uploader.toLowerCase();

        let debugConfig: Configuration | undefined;

        // find if config exists
        let index = config_list.findIndex((conf) => {
            return conf.type === this.typeTag && conf.name === `${this.typeTag} ${uploader_name}`;
        });

        if (index !== -1) {
            debugConfig = config_list[index];
        } else {
            const def_list = this.getDefault();
            index = def_list.findIndex((conf) => { return conf.name === `${this.typeTag} ${uploader_name}`; });
            if (index !== -1) {
                debugConfig = def_list[index];
                config_list.push(debugConfig); // add to config list
            }
        }

        // update config if found one
        if (debugConfig) {

            // must use elf to debug
            debugConfig.program = prj.getOutputDir() + File.sep + prjConfig.name + '.elf';

            // TODO: targetArchitecture for ARM & ARM64?
            // Need to detect if a prj is 'arm' or 'arm64' when prjConfig.type === 'ARM'.
            // Without targetArchitecture, cppdbg can auto detect arch in some cases,
            // ARM & ARM64 may be fine, however MIPS generally need specifying.
            if (prjConfig.type === 'MIPS') {
                debugConfig.targetArchitecture = 'mips';
            }

            const toolchain = prj.getToolchain();
            if (toolchain.getToolchainPrefix) {
                debugConfig.miDebuggerPath = toolchain.getToolchainPrefix().trim() + 'gdb';
            }

            if (debugConfig.name == `${this.typeTag} ${uploader_name}`) {
                if ('openocd' == debugConfig.name) {
                    const openocdConf = <OpenOCDFlashOptions>JSON.parse(JSON.stringify(prjConfig.uploadConfig));

                    debugConfig.debugServerPath = SettingManager.GetInstance().getOpenOCDExePath();

                    if (!openocdConf.use_custom_args) {

                        if (!openocdConf.interface.startsWith('${workspaceFolder}/')) {
                            openocdConf.interface = `interface/${openocdConf.interface}`;
                        }
                        if (!openocdConf.target.startsWith('${workspaceFolder}/')) {
                            openocdConf.target = `target/${openocdConf.target}`;
                        }
    
                        debugConfig.debugServerArgs = `-f "${openocdConf.interface}.cfg" -f "${openocdConf.target}.cfg"`;

                    } else {
                        debugConfig.debugServerArgs = openocdConf.custom_args;
                    }
                }
            }

        }
    }

    private getDefault(): Configuration[] {
        
        // TODO: Provide a gdb commands editor, or maybe put them to debug.files.options.yml?
        const setupCommands = [
            { "text": "set endian little" },
            { "text": "set mem inaccessible-by-default off" },
            { "text": "set disassemble-next-line on" },
            { "text": "-environment-cd ${workspaceFolder}" },
            { "text": "dir src/asm" },
        ];
        const postRemoteConnectCommands = [
            { "text": "set $pc=0xa0070000" },
        ];

        return [
            Object.assign(
                {
                    cwd: '${workspaceFolder}',
                    type: this.typeTag,
                    request: 'launch',
                    name: `${this.typeTag} openocd`,
                    MIMode: 'gdb'
                },
                this.openocdConnectConfig,
                {
                    setupCommands,
                    postRemoteConnectCommands
                }
            )
        ];
    }

}

class CortexDebugConfigProvider extends IDebugConfigProvider {

    typeTag: string = 'cortex-debug';

    hexUploaderMatcher: HexUploaderType[] = ['JLink', 'OpenOCD', 'STLink', 'pyOCD'];

    update(prj: AbstractProject, config_list: Configuration[]): void {

        const prjConfig = prj.GetConfiguration<ArmBaseCompileData>().config;
        const uploader = prj.GetConfiguration().uploadConfigModel.uploader;
        const outDir = prj.getOutputDir();
        const uploader_name = uploader.toLowerCase();

        let debugConfig: Configuration | undefined;

        // find config is exist
        let index = config_list.findIndex((conf) => {
            return conf.type === this.typeTag && (conf.servertype === uploader_name || conf.name === uploader_name);
        });

        if (index !== -1) { // found config
            debugConfig = config_list[index];
        } else { // not found, use default
            const def_list = this.getDefault();
            index = def_list.findIndex((conf) => { return conf.name === uploader_name; });
            if (index !== -1) {
                debugConfig = def_list[index];
                config_list.push(debugConfig); // add to config list
            }
        }

        // update config if found one
        if (debugConfig) {

            // must use elf to debug
            debugConfig.executable = outDir + File.sep + prjConfig.name + '.elf';

            const toolchain = prj.getToolchain();
            if (toolchain.getToolchainPrefix) {
                debugConfig.toolchainPrefix = toolchain.getToolchainPrefix().trim().replace(/-$/, '');
            } else if (debugConfig.toolchainPrefix) {
                debugConfig.toolchainPrefix = undefined;
            }

            // setup svd file, if existed
            const device = prj.GetPackManager().getCurrentDevInfo();
            if (device && device.svdPath && debugConfig.svdFile == undefined) {
                debugConfig.svdFile = prj.ToRelativePath(device.svdPath) || device.svdPath;
            }

            // setup specific debugger options
            if (debugConfig.servertype == uploader_name) {

                if ('pyocd' == debugConfig.servertype) {
                    const pyocdOptions = <PyOCDFlashOptions>prjConfig.uploadConfig;
                    debugConfig.targetId = pyocdOptions.targetName;
                    const pyocdConfFile = new File(prj.ToAbsolutePath(pyocdOptions.config || ''));
                    if (pyocdConfFile.IsFile()) {
                        const conf = YAML.parse(pyocdConfFile.Read());
                        if (conf && Array.isArray(conf['pack'])) {
                            debugConfig.cmsisPack = conf['pack'][0];
                        }
                    }
                }

                else if ('openocd' == debugConfig.servertype) {
                    const openocdConf = <OpenOCDFlashOptions>JSON.parse(JSON.stringify(prjConfig.uploadConfig));

                    if (!openocdConf.use_custom_args) {

                        if (!openocdConf.interface.startsWith('${workspaceFolder}/')) {
                            openocdConf.interface = `interface/${openocdConf.interface}`;
                        }
                        if (!openocdConf.target.startsWith('${workspaceFolder}/')) {
                            openocdConf.target = `target/${openocdConf.target}`;
                        }
    
                        debugConfig.configFiles = [
                            `${openocdConf.interface}.cfg`,
                            `${openocdConf.target}.cfg`
                        ];

                    } else {
                        // TODO: remind the user to fill in openocd related entries themselves:
                        // configFiles, searchDir, openOCDPreConfigLaunchCommands and openOCDLaunchCommands
                    }
                }

                else if ('jlink' == debugConfig.servertype) {
                    const jlinkUploadConf = <JLinkOptions>prjConfig.uploadConfig;
                    debugConfig.interface = ProtocolType[jlinkUploadConf.proType].toLowerCase();
                    debugConfig.device = jlinkUploadConf.cpuInfo.cpuName;
                }
            }
        }
    }

    private getDefault(): Configuration[] {
        return [
            {
                cwd: '${workspaceRoot}',
                type: this.typeTag,
                request: 'launch',
                name: `jlink`,
                servertype: 'jlink',
                interface: 'swd',
                executable: 'undefined',
                runToEntryPoint: "main",
                device: '<mcu-name>'
            },
            {
                cwd: '${workspaceRoot}',
                type: this.typeTag,
                request: 'launch',
                name: `stlink`,
                servertype: 'openocd',
                executable: 'undefined',
                runToEntryPoint: "main",
                configFiles: [
                    "interface/stlink.cfg",
                    "target/<target-name>.cfg"
                ]
            },
            {
                cwd: '${workspaceRoot}',
                type: this.typeTag,
                request: 'launch',
                name: `openocd`,
                servertype: 'openocd',
                executable: 'undefined',
                runToEntryPoint: "main",
                configFiles: [
                    "interface/<debugger-type>.cfg",
                    "target/<target-name>.cfg"
                ]
            },
            {
                cwd: '${workspaceRoot}',
                type: this.typeTag,
                request: 'launch',
                name: `pyocd`,
                servertype: 'pyocd',
                executable: 'undefined',
                runToEntryPoint: "main",
                targetId: '<mcu-name>'
            }
        ];
    }
}

class STM8DebugConfigProvider extends IDebugConfigProvider {

    typeTag: string = 'stm8-debug';

    hexUploaderMatcher: HexUploaderType[] = ['STVP'];

    update(prj: AbstractProject, config_list: Configuration[]): void {

        const prjConfig = prj.GetConfiguration<any>().config;
        const toolchain_name = prj.getToolchain().name;

        let elf_suffix: string;
        let require_ser_name: string;

        switch (toolchain_name) {
            case 'IAR_STM8':
                elf_suffix = '.out';
                require_ser_name = 'st7';
                break;
            case 'COSMIC_STM8':
                elf_suffix = '.elf';
                require_ser_name = 'st7';
                break;
            default:
                elf_suffix = '.elf';
                require_ser_name = 'openocd';
                break;
        }

        let debugConfig: Configuration | undefined;

        // find config is exist
        let index = config_list.findIndex((conf) => { return conf.type === this.typeTag && conf.name === require_ser_name; });

        if (index !== -1) {
            debugConfig = config_list[index];
        } else {
            const def_list = this.getDefault();
            index = def_list.findIndex((conf) => { return conf.name === require_ser_name; });
            if (index !== -1) {
                debugConfig = def_list[index];
                config_list.push(debugConfig); // add to config list
            }
        }

        // update config
        if (debugConfig) {
            debugConfig.executable = prj.getOutputDir() + File.sep + prjConfig.name + elf_suffix;
        }
    }

    private getDefault(): Configuration[] {
        return [
            {
                type: this.typeTag,
                request: 'launch',
                name: 'st7',
                serverType: 'st7',
                interface: 'stlink3',
                cpu: '<mcu-name>',
                executable: 'null'
            },
            {
                type: this.typeTag,
                request: 'launch',
                name: 'openocd',
                serverType: 'stm8-sdcc',
                executable: 'null',
                openOcdConfigs: [
                    "interface/stlink.cfg",
                    "target/<target-name>.cfg"
                ]
            }
        ];
    }
}
